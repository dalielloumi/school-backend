const https = require('https');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');
const { query } = require('../config/db');

const PROJECT_ID = 'school-2a8c7';
const FCM_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;

// Load service account key
const KEY_PATH = path.join(__dirname, '../../serviceAccountKey.json');

let _auth = null;
function getAuth() {
  if (!_auth) {
    _auth = new GoogleAuth({
      keyFile: KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
  }
  return _auth;
}

async function getAccessToken() {
  try {
    const client = await getAuth().getClient();
    const token = await client.getAccessToken();
    return token.token;
  } catch (e) {
    console.error('[FCM] Failed to get access token:', e.message);
    return null;
  }
}

async function _sendOne(token, title, body, data) {
  const accessToken = await getAccessToken();
  if (!accessToken) return;

  const payload = JSON.stringify({
    message: {
      token,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: { sound: 'default', channel_id: 'edumanage_channel' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } },
      },
    },
  });

  return new Promise((resolve) => {
    const url = new URL(FCM_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error('[FCM] Error:', res.statusCode, body);
          }
          resolve(null);
        });
      }
    );
    req.on('error', (e) => { console.error('[FCM]', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

/**
 * Send push notification to a list of FCM tokens.
 * @param {string[]} tokens
 * @param {string} title
 * @param {string} body
 * @param {object} data — all values must be strings
 */
async function sendPush(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;
  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

  // FCM v1 sends one message per token (no batch endpoint)
  await Promise.all(tokens.map((token) => _sendOne(token, title, body, stringData)));
}

/** FCM tokens for given user IDs */
async function getTokensForUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const res = await query(
    'SELECT fcm_token FROM users WHERE id = ANY($1) AND fcm_token IS NOT NULL',
    [userIds]
  );
  return res.rows.map((r) => r.fcm_token);
}

/** FCM tokens of parents whose children are in a classe */
async function getParentTokensForClasse(schoolId, classeId) {
  const res = await query(
    `SELECT DISTINCT u.fcm_token FROM users u
     JOIN students s ON s.parent_id = u.id
     WHERE s.classe_id = $1 AND s.school_id = $2 AND u.fcm_token IS NOT NULL`,
    [classeId, schoolId]
  );
  return res.rows.map((r) => r.fcm_token);
}

/** FCM tokens of parents whose children are in any of the given classes */
async function getParentTokensForClasses(schoolId, classeIds) {
  if (!classeIds || classeIds.length === 0) return [];
  const res = await query(
    `SELECT DISTINCT u.fcm_token FROM users u
     JOIN students s ON s.parent_id = u.id
     WHERE s.classe_id = ANY($1) AND s.school_id = $2 AND u.fcm_token IS NOT NULL`,
    [classeIds, schoolId]
  );
  return res.rows.map((r) => r.fcm_token);
}

/** FCM tokens for all active users with a given role in a school */
async function getTokensByRole(schoolId, role) {
  const res = await query(
    'SELECT fcm_token FROM users WHERE role = $1 AND school_id = $2 AND fcm_token IS NOT NULL AND is_active = TRUE',
    [role, schoolId]
  );
  return res.rows.map((r) => r.fcm_token);
}

module.exports = { sendPush, getTokensForUsers, getParentTokensForClasse, getParentTokensForClasses, getTokensByRole };
