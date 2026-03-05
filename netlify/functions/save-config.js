// netlify/functions/save-config.js
const { initializeApp, getApps } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc } = require('firebase/firestore');

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

  const app = initFirebase();
  const db = getFirestore(app);

  // GET config
  if (event.httpMethod === 'GET') {
    try {
      const snap = await getDoc(doc(db, 'config', 'integration'));
      if (!snap.exists()) return { statusCode: 200, headers, body: JSON.stringify({ config: null }) };

      // Mascarar dados sensíveis ao retornar
      const data = snap.data();
      const masked = {
        ...data,
        glpiPassword: data.glpiPassword ? '••••••••' : '',
        azurePat: data.azurePat ? data.azurePat.substring(0, 4) + '••••••••' : '',
        glpiUserToken: data.glpiUserToken ? data.glpiUserToken.substring(0, 4) + '••••••••' : '',
      };
      return { statusCode: 200, headers, body: JSON.stringify({ config: masked }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // POST save config
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);

      // Se campo vier com máscara, manter o valor anterior
      const existing = await getDoc(doc(db, 'config', 'integration'));
      const existingData = existing.exists() ? existing.data() : {};

      const config = {
        // GLPI
        glpiUrl: body.glpiUrl?.replace(/\/$/, '') || existingData.glpiUrl || '',
        glpiAppToken: body.glpiAppToken || existingData.glpiAppToken || '',
        glpiUserToken: body.glpiUserToken?.includes('••') ? existingData.glpiUserToken : (body.glpiUserToken || existingData.glpiUserToken || ''),
        glpiLogin: body.glpiLogin || existingData.glpiLogin || '',
        glpiPassword: body.glpiPassword?.includes('••') ? existingData.glpiPassword : (body.glpiPassword || existingData.glpiPassword || ''),
        // Azure DevOps
        azureOrg: body.azureOrg || existingData.azureOrg || '',
        azureProject: body.azureProject || existingData.azureProject || '',
        azurePat: body.azurePat?.includes('••') ? existingData.azurePat : (body.azurePat || existingData.azurePat || ''),
        azureWorkItemType: body.azureWorkItemType || existingData.azureWorkItemType || 'Task',
        azureAreaPath: body.azureAreaPath || existingData.azureAreaPath || '',
        azureIterationPath: body.azureIterationPath || existingData.azureIterationPath || '',
        // Webhook
        webhookSecret: body.webhookSecret || existingData.webhookSecret || '',
        updatedAt: new Date().toISOString(),
      };

      await setDoc(doc(db, 'config', 'integration'), config);
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Configuração salva com sucesso!' }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
