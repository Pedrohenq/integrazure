// netlify/functions/azure-webhook.js
// Recebe webhooks do Azure DevOps e adiciona comentários no GLPI

const { initializeApp, getApps } = require('firebase/app');
const { getFirestore, doc, getDoc, addDoc, collection, serverTimestamp, getDocs, query, where } = require('firebase/firestore');

function initFirebase() {
  if (getApps().length > 0) return getApps()[0];
  return initializeApp({
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
  });
}

async function getConfig() {
  const app = initFirebase();
  const db = getFirestore(app);
  const snap = await getDoc(doc(db, 'config', 'integration'));
  if (!snap.exists()) throw new Error('Configuração não encontrada.');
  return snap.data();
}

async function logSync(type, status, details) {
  try {
    const app = initFirebase();
    const db = getFirestore(app);
    await addDoc(collection(db, 'sync_logs'), { type, status, details, timestamp: serverTimestamp() });
  } catch (e) { console.error('Log error:', e); }
}

async function findMappingByAzureId(azureId) {
  const app = initFirebase();
  const db = getFirestore(app);
  const q = query(collection(db, 'ticket_mappings'), where('azureId', '==', String(azureId)));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

async function getGlpiSessionToken(config) {
  const { glpiUrl, glpiAppToken, glpiUserToken, glpiLogin, glpiPassword } = config;
  const headers = { 'App-Token': glpiAppToken, 'Content-Type': 'application/json' };

  if (glpiUserToken) {
    headers['Authorization'] = `user_token ${glpiUserToken}`;
  } else {
    headers['Authorization'] = `Basic ${Buffer.from(`${glpiLogin}:${glpiPassword}`).toString('base64')}`;
  }

  const res = await fetch(`${glpiUrl}/apirest.php/initSession`, { method: 'GET', headers });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GLPI auth failed: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return data.session_token;
}

async function addGlpiComment(config, ticketId, commentText) {
  const sessionToken = await getGlpiSessionToken(config);
  const { glpiUrl, glpiAppToken } = config;

  const res = await fetch(`${glpiUrl}/apirest.php/Ticket/${ticketId}/ITILFollowup`, {
    method: 'POST',
    headers: {
      'App-Token': glpiAppToken,
      'Session-Token': sessionToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        items_id: parseInt(ticketId),
        itemtype: 'Ticket',
        content: commentText,
        is_private: 0,
      },
    }),
  });

  // Fechar sessão
  await fetch(`${glpiUrl}/apirest.php/killSession`, {
    method: 'GET',
    headers: { 'App-Token': glpiAppToken, 'Session-Token': sessionToken },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GLPI followup error: ${res.status} - ${err}`);
  }

  return res.json();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const config = await getConfig();

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    // Azure envia eventos em formatos diferentes dependendo do tipo
    const eventType = payload.eventType || payload.subscriptionId;
    const resource = payload.resource || {};

    // Evento de comentário em work item
    if (eventType === 'workitem.commented' || eventType === 'ms.vss-work.workitem-commented-event') {
      const workItemId = resource.workItemId || resource.id || resource.fields?.['System.Id'];
      const commentText = resource.text || resource.comment || resource.fields?.['System.Description'] || '';
      const author = resource.revisedBy?.displayName || resource.changedBy || 'Azure DevOps';

      if (!workItemId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No work item ID' }) };
      }

      const mapping = await findMappingByAzureId(workItemId);
      if (!mapping) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: `Work item ${workItemId} não está mapeado para nenhum chamado GLPI` }) };
      }

      const glpiComment = `[Azure DevOps - ${author}]:\n${commentText}`;
      await addGlpiComment(config, mapping.glpiId, glpiComment);
      await logSync('azure_to_glpi', 'success', {
        action: 'comment_added',
        azureId: workItemId,
        glpiId: mapping.glpiId,
        author,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Comentário adicionado no GLPI', glpiId: mapping.glpiId }),
      };
    }

    // Evento de atualização de work item
    if (eventType === 'workitem.updated' || eventType === 'ms.vss-work.workitem-updated-event') {
      const workItemId = resource.workItemId || resource.id;
      const fields = resource.fields || resource.revisedFields || {};

      // Verifica se houve mudança de estado
      const stateChange = fields['System.State'];
      if (!stateChange) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Nenhuma mudança relevante detectada' }) };
      }

      const mapping = await findMappingByAzureId(workItemId);
      if (!mapping) {
        return { statusCode: 200, headers, body: JSON.stringify({ message: `Work item ${workItemId} não está mapeado` }) };
      }

      const oldState = stateChange.oldValue || '?';
      const newState = stateChange.newValue || '?';
      const changedBy = resource.revisedBy?.displayName || 'Azure DevOps';
      const comment = `[Azure DevOps] Status atualizado por ${changedBy}: ${oldState} → ${newState}`;

      await addGlpiComment(config, mapping.glpiId, comment);
      await logSync('azure_to_glpi', 'success', {
        action: 'status_change',
        azureId: workItemId,
        glpiId: mapping.glpiId,
        oldState,
        newState,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Status sincronizado no GLPI', glpiId: mapping.glpiId }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ message: `Evento '${eventType}' não processado` }) };

  } catch (error) {
    console.error('Erro webhook Azure:', error);
    await logSync('azure_to_glpi', 'error', { error: error.message });
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
