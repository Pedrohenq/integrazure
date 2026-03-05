// netlify/functions/get-mappings.js
const { initializeApp, getApps } = require('firebase/app');
const { getFirestore, collection, getDocs, query, orderBy, limit, doc, deleteDoc } = require('firebase/firestore');

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

  if (event.httpMethod === 'GET') {
    try {
      const q = query(collection(db, 'ticket_mappings'), orderBy('createdAt', 'desc'), limit(200));
      const snap = await getDocs(q);
      const mappings = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null,
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ mappings }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod === 'DELETE') {
    try {
      const { id } = JSON.parse(event.body);
      await deleteDoc(doc(db, 'ticket_mappings', id));
      return { statusCode: 200, headers, body: JSON.stringify({ message: 'Mapeamento removido' }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
