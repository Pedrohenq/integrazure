// netlify/functions/test-connection.js
const { initializeApp, getApps } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');

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

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { target } = JSON.parse(event.body);
    const app = initFirebase();
    const db = getFirestore(app);
    const snap = await getDoc(doc(db, 'config', 'integration'));

    if (!snap.exists()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Configure a integração primeiro' }) };
    }

    const config = snap.data();
    const results = {};

    // Testar GLPI
    if (target === 'glpi' || target === 'all') {
      try {
        const { glpiUrl, glpiAppToken, glpiUserToken, glpiLogin, glpiPassword } = config;
        const authHeaders = { 'App-Token': glpiAppToken };

        if (glpiUserToken) {
          authHeaders['Authorization'] = `user_token ${glpiUserToken}`;
        } else {
          authHeaders['Authorization'] = `Basic ${Buffer.from(`${glpiLogin}:${glpiPassword}`).toString('base64')}`;
        }

        const res = await fetch(`${glpiUrl}/apirest.php/initSession`, { headers: authHeaders });
        if (res.ok) {
          const data = await res.json();
          // Fechar sessão
          await fetch(`${glpiUrl}/apirest.php/killSession`, {
            headers: { 'App-Token': glpiAppToken, 'Session-Token': data.session_token },
          });
          results.glpi = { success: true, message: 'Conexão com GLPI bem-sucedida!' };
        } else {
          const err = await res.text();
          results.glpi = { success: false, message: `Falha GLPI: ${res.status} - ${err.substring(0, 100)}` };
        }
      } catch (e) {
        results.glpi = { success: false, message: `Erro GLPI: ${e.message}` };
      }
    }

    // Testar Azure DevOps
    if (target === 'azure' || target === 'all') {
      try {
        const { azureOrg, azureProject, azurePat } = config;
        const token = Buffer.from(`:${azurePat}`).toString('base64');
        const res = await fetch(
          `https://dev.azure.com/${azureOrg}/${azureProject}/_apis/wit/workitemtypes?api-version=7.1`,
          { headers: { Authorization: `Basic ${token}` } }
        );
        if (res.ok) {
          const data = await res.json();
          results.azure = { success: true, message: `Azure DevOps conectado! ${data.count || 0} tipos de work item encontrados.` };
        } else {
          const err = await res.text();
          results.azure = { success: false, message: `Falha Azure: ${res.status} - ${err.substring(0, 100)}` };
        }
      } catch (e) {
        results.azure = { success: false, message: `Erro Azure: ${e.message}` };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
