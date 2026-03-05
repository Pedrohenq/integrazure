// netlify/functions/glpi-webhook.js
// Recebe webhooks do GLPI e cria/atualiza work items no Azure DevOps

const { initializeApp, getApps } = require('firebase/app');
const { getFirestore, doc, getDoc, addDoc, collection, serverTimestamp } = require('firebase/firestore');

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
  if (!snap.exists()) throw new Error('Configuração não encontrada. Configure a integração primeiro.');
  return snap.data();
}

async function logSync(type, status, details) {
  try {
    const app = initFirebase();
    const db = getFirestore(app);
    await addDoc(collection(db, 'sync_logs'), {
      type,
      status,
      details,
      timestamp: serverTimestamp(),
    });
  } catch (e) {
    console.error('Erro ao gravar log:', e);
  }
}

async function createAzureWorkItem(config, glpiTicket) {
  const { azureOrg, azureProject, azurePat, azureWorkItemType, azureAreaPath, azureIterationPath } = config;

  const token = Buffer.from(`:${azurePat}`).toString('base64');
  const baseUrl = `https://dev.azure.com/${azureOrg}/${azureProject}/_apis/wit/workitems/$${encodeURIComponent(azureWorkItemType || 'Task')}?api-version=7.1`;

  const priorityMap = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4 };
  const priority = priorityMap[glpiTicket.priority] || 3;

  const body = [
    { op: 'add', path: '/fields/System.Title', value: `[GLPI #${glpiTicket.id}] ${glpiTicket.name}` },
    { op: 'add', path: '/fields/System.Description', value: `<b>Chamado GLPI:</b> #${glpiTicket.id}<br/><b>Solicitante:</b> ${glpiTicket.requester || 'N/A'}<br/><b>Categoria:</b> ${glpiTicket.category || 'N/A'}<br/><hr/>${glpiTicket.content || ''}` },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: priority },
    { op: 'add', path: '/fields/System.Tags', value: `GLPI;glpi-${glpiTicket.id}` },
  ];

  if (azureAreaPath) body.push({ op: 'add', path: '/fields/System.AreaPath', value: azureAreaPath });
  if (azureIterationPath) body.push({ op: 'add', path: '/fields/System.IterationPath', value: azureIterationPath });

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json-patch+json',
      Authorization: `Basic ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure API error: ${response.status} - ${err}`);
  }

  return response.json();
}

async function updateAzureWorkItem(config, azureId, comment) {
  const { azureOrg, azureProject, azurePat } = config;
  const token = Buffer.from(`:${azurePat}`).toString('base64');
  const url = `https://dev.azure.com/${azureOrg}/${azureProject}/_apis/wit/workitems/${azureId}/comments?api-version=7.1-preview.3`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${token}`,
    },
    body: JSON.stringify({ text: comment }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure comment error: ${response.status} - ${err}`);
  }

  return response.json();
}

async function saveMapping(glpiId, azureId) {
  const app = initFirebase();
  const db = getFirestore(app);
  await addDoc(collection(db, 'ticket_mappings'), {
    glpiId: String(glpiId),
    azureId: String(azureId),
    createdAt: serverTimestamp(),
  });
}

async function findMapping(glpiId) {
  const app = initFirebase();
  const db = getFirestore(app);
  const { getDocs, query, where } = require('firebase/firestore');
  const q = query(collection(db, 'ticket_mappings'), where('glpiId', '==', String(glpiId)));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const config = await getConfig();

    // Validar secret do webhook
    const webhookSecret = event.headers['x-glpi-webhook-secret'] || event.queryStringParameters?.secret;
    if (config.webhookSecret && webhookSecret !== config.webhookSecret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { event: glpiEvent, items_id, itemtype } = payload;

    // Só processa tickets
    if (itemtype && itemtype !== 'Ticket') {
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Ignored non-ticket event' }) };
    }

    const glpiTicket = payload.ticket || payload.data || payload;
    const ticketId = items_id || glpiTicket.id;

    if (!ticketId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No ticket ID found in payload' }) };
    }

    // Evento de NOVO chamado
    if (glpiEvent === 'add' || glpiEvent === 'new' || glpiEvent === 'create') {
      const azureItem = await createAzureWorkItem(config, {
        id: ticketId,
        name: glpiTicket.name || glpiTicket.title || `Chamado #${ticketId}`,
        content: glpiTicket.content || glpiTicket.description || '',
        priority: glpiTicket.priority || 3,
        requester: glpiTicket.requester || glpiTicket.users_id_recipient || '',
        category: glpiTicket.category || '',
      });

      await saveMapping(ticketId, azureItem.id);
      await logSync('glpi_to_azure', 'success', {
        action: 'created',
        glpiId: ticketId,
        azureId: azureItem.id,
        azureUrl: azureItem._links?.html?.href,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Work item criado no Azure DevOps',
          glpiId: ticketId,
          azureId: azureItem.id,
        }),
      };
    }

    // Evento de COMENTÁRIO/ATUALIZAÇÃO
    if (glpiEvent === 'update' || glpiEvent === 'add_followup' || glpiEvent === 'followup') {
      const mapping = await findMapping(ticketId);
      if (!mapping) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Nenhum mapeamento encontrado para GLPI #${ticketId}` }) };
      }

      const commentText = glpiTicket.content || glpiTicket.answer || payload.content || 'Atualização via GLPI';
      const author = glpiTicket.author || glpiTicket.users_id || 'GLPI';
      const fullComment = `<b>[GLPI] ${author}:</b><br/>${commentText}`;

      await updateAzureWorkItem(config, mapping.azureId, fullComment);
      await logSync('glpi_to_azure', 'success', {
        action: 'comment_added',
        glpiId: ticketId,
        azureId: mapping.azureId,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Comentário adicionado no Azure', azureId: mapping.azureId }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ message: `Evento '${glpiEvent}' ignorado` }) };

  } catch (error) {
    console.error('Erro no webhook GLPI:', error);
    await logSync('glpi_to_azure', 'error', { error: error.message });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
