// ============================================================
// background.js — Service Worker
// Handles OAuth and all Tumblr API calls.
// Credentials are entered by the user on first run and stored
// in chrome.storage.local — never hardcoded, safe to open source.
// ============================================================

const TUMBLR_API_BASE = 'https://api.tumblr.com/v2';
// Set this to your Vercel deployment URL after deploying the /callback folder
// e.g. https://tumblr-folders-callback.vercel.app/callback
const REDIRECT_URI = 'https://YOUR_VERCEL_URL.vercel.app/callback';

// ============================================================
// MESSAGE ROUTER
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_REDIRECT_URI':
          sendResponse({ uri: 'https://tumblr-ui-folders.vercel.app', note: 'Set this in your Tumblr app\'s Default Callback URL and OAuth2 redirect URLs fields.' });
          break;
        case 'SAVE_CREDENTIALS':
          sendResponse(await saveCredentials(msg.clientId, msg.clientSecret));
          break;
        case 'GET_CREDENTIALS_STATUS':
          sendResponse(await getCredentialsStatus());
          break;
        case 'OAUTH_LOGIN':
          sendResponse(await doOAuthLogin());
          break;
        case 'GET_AUTH_STATUS':
          sendResponse(await getAuthStatus());
          break;
        case 'LOGOUT':
          await chrome.storage.local.remove(['tf_access_token', 'tf_refresh_token', 'tf_blog_name']);
          sendResponse({ success: true });
          break;
        case 'CLEAR_CREDENTIALS':
          await chrome.storage.local.remove(['tf_client_id', 'tf_client_secret', 'tf_access_token', 'tf_refresh_token', 'tf_blog_name']);
          sendResponse({ success: true });
          break;
        case 'FETCH_DRAFTS':
          sendResponse(await fetchAllDrafts(msg.blogName));
          break;
        case 'MIGRATE_DRAFTS':
          sendResponse(await migrateDraftsToPrivate(msg.blogName, msg.postIds));
          break;
        case 'FETCH_PRIVATE_POSTS':
          sendResponse(await fetchPrivatePosts(msg.blogName, msg.tag));
          break;
        case 'SAVE_POST_TO_FOLDER':
          sendResponse(await savePostToFolder(msg.blogName, msg.postUrl, msg.folder));
          break;
        case 'ASSIGN_FOLDER':
          sendResponse(await assignFolder(msg.blogName, msg.postId, msg.folder, msg.previousFolder));
          break;
        case 'GET_FOLDERS':
          sendResponse(await getFolders());
          break;
        case 'CREATE_FOLDER':
          sendResponse(await createFolder(msg.name));
          break;
        case 'DELETE_FOLDER':
          sendResponse(await deleteFolder(msg.name));
          break;
        case 'GET_INFO':
          sendResponse(await getBlogInfo());
          break;
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (e) {
      console.error('[TF]', e);
      sendResponse({ error: e.message });
    }
  })();
  return true;
});

// ============================================================
// CREDENTIAL MANAGEMENT
// ============================================================
async function saveCredentials(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    return { success: false, error: 'Both Client ID and Client Secret are required.' };
  }
  await chrome.storage.local.set({
    tf_client_id: clientId.trim(),
    tf_client_secret: clientSecret.trim(),
  });
  return { success: true };
}

async function getCredentials() {
  const data = await chrome.storage.local.get(['tf_client_id', 'tf_client_secret']);
  if (!data.tf_client_id || !data.tf_client_secret) {
    throw new Error('NO_CREDENTIALS');
  }
  return { clientId: data.tf_client_id, clientSecret: data.tf_client_secret };
}

async function getCredentialsStatus() {
  const data = await chrome.storage.local.get(['tf_client_id', 'tf_client_secret']);
  return { hasCredentials: !!(data.tf_client_id && data.tf_client_secret) };
}

// ============================================================
// OAUTH 2.0 — PKCE flow
// ============================================================
// Pending OAuth resolvers keyed by verifier/state
const pendingOAuth = new Map();

// Listen for the callback message from the Vercel redirect page
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TF_OAUTH_CALLBACK') {
    const resolve = pendingOAuth.get(msg.state);
    if (resolve) {
      pendingOAuth.delete(msg.state);
      resolve({ code: msg.code, state: msg.state });
    }
  }
});

// Also listen for tab URL changes to catch the redirect
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!changeInfo.url.startsWith(REDIRECT_URI)) return;

  const url = new URL(changeInfo.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (code && state) {
    const resolve = pendingOAuth.get(state);
    if (resolve) {
      pendingOAuth.delete(state);
      resolve({ code, state });
      // Close the auth tab
      chrome.tabs.remove(tabId);
    }
  }
});

async function doOAuthLogin() {
  const { clientId, clientSecret } = await getCredentials();
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);

  const authUrl = new URL('https://www.tumblr.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', 'basic write offline_access');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', verifier);

  // Open auth in a new tab
  chrome.tabs.create({ url: authUrl.toString() });

  // Wait for the callback
  return new Promise((resolve) => {
    pendingOAuth.set(verifier, async ({ code, state: returnedState }) => {
      try {
        const tokenRes = await fetch('https://api.tumblr.com/v2/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: REDIRECT_URI,
            code_verifier: returnedState,
          }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          resolve({ success: false, error: JSON.stringify(tokenData) });
          return;
        }

        const userRes = await fetch(`${TUMBLR_API_BASE}/user/info`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userRes.json();
        const blogName = userData.response?.user?.blogs?.[0]?.name;

        await chrome.storage.local.set({
          tf_access_token: tokenData.access_token,
          tf_refresh_token: tokenData.refresh_token,
          tf_blog_name: blogName,
        });

        resolve({ success: true, blogName });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingOAuth.has(verifier)) {
        pendingOAuth.delete(verifier);
        resolve({ success: false, error: 'Login timed out' });
      }
    }, 5 * 60 * 1000);
  });
}

async function getAuthStatus() {
  const data = await chrome.storage.local.get(['tf_access_token', 'tf_blog_name', 'tf_client_id']);
  return {
    authenticated: !!data.tf_access_token,
    hasCredentials: !!data.tf_client_id,
    blogName: data.tf_blog_name || null,
  };
}

async function getToken() {
  const data = await chrome.storage.local.get('tf_access_token');
  if (!data.tf_access_token) throw new Error('Not authenticated');
  return data.tf_access_token;
}

// ============================================================
// TUMBLR API HELPERS
// ============================================================
async function apiGet(path, params = {}) {
  const token = await getToken();
  const url = new URL(`${TUMBLR_API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function apiPost(path, body = {}) {
  const token = await getToken();
  const res = await fetch(`${TUMBLR_API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ============================================================
// DRAFTS
// ============================================================
async function fetchAllDrafts(blogName) {
  let allDrafts = [];
  let beforeId = undefined;

  while (true) {
    const params = { limit: 50 };
    if (beforeId) params.before_id = beforeId;
    const data = await apiGet(`/blog/${blogName}/posts/draft`, params);
    const posts = data.response?.posts || [];
    if (posts.length === 0) break;
    allDrafts = allDrafts.concat(posts.map(normalizePost));
    beforeId = posts[posts.length - 1].id_string;
    if (posts.length < 50) break;
  }

  return { success: true, drafts: allDrafts, count: allDrafts.length };
}

async function migrateDraftsToPrivate(blogName, postIds) {
  const results = { success: 0, failed: 0, errors: [] };
  const BATCH_SIZE = 5;

  for (let i = 0; i < postIds.length; i += BATCH_SIZE) {
    const batch = postIds.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (postId) => {
        try {
          const postData = await apiGet(`/blog/${blogName}/posts`, { id: postId });
          const post = postData.response?.posts?.[0];
          const existingTags = post?.tags || [];
          const hasFolderTag = existingTags.some(t => t.startsWith('tf-folder:'));
          const newTags = hasFolderTag
            ? existingTags
            : [...existingTags.filter(t => !t.startsWith('tf-folder:')), 'tf-folder:unsorted'];

          await apiPost(`/blog/${blogName}/post/edit`, {
            id: postId,
            state: 'private',
            tags: newTags.join(','),
          });
          results.success++;
        } catch (e) {
          results.failed++;
          results.errors.push({ postId, error: e.message });
        }
      })
    );
    if (i + BATCH_SIZE < postIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

// ============================================================
// PRIVATE POSTS / FOLDERS
// ============================================================
async function fetchPrivatePosts(blogName, folderTag = null) {
  let allPosts = [];
  let offset = 0;
  const LIMIT = 50;

  while (true) {
    const data = await apiGet(`/blog/${blogName}/posts`, {
      type: 'any',
      filter: 'raw',
      limit: LIMIT,
      offset,
    });
    const privatePosts = (data.response?.posts || []).filter(p => p.state === 'private');
    allPosts = allPosts.concat(privatePosts.map(normalizePost));
    if ((data.response?.posts?.length || 0) < LIMIT) break;
    offset += LIMIT;
    if (offset > 500) break;
  }

  if (folderTag) {
    const tagToMatch = `tf-folder:${folderTag}`;
    allPosts = allPosts.filter(p => p.tags.includes(tagToMatch));
  } else {
    allPosts = allPosts.filter(p => p.tags.some(t => t.startsWith('tf-folder:')));
  }

  return { success: true, posts: allPosts };
}

async function savePostToFolder(blogName, postUrl, folder) {
  try {
    const match = postUrl.match(/\/post\/(\d+)/);
    if (!match) throw new Error('Could not parse post URL');
    const postId = match[1];
    const postData = await apiGet(`/blog/${blogName}/posts`, { id: postId });
    const post = postData.response?.posts?.[0];
    if (!post) throw new Error('Post not found');

    await apiPost(`/blog/${blogName}/post/reblog`, {
      id: postId,
      reblog_key: post.reblog_key,
      state: 'private',
      tags: `tf-folder:${folder}`,
    });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function assignFolder(blogName, postId, newFolder, previousFolder) {
  try {
    const postData = await apiGet(`/blog/${blogName}/posts`, { id: postId });
    const post = postData.response?.posts?.[0];
    if (!post) throw new Error('Post not found');
    const existingTags = post.tags || [];
    const filteredTags = existingTags.filter(t => !t.startsWith('tf-folder:'));
    const newTags = [...filteredTags, `tf-folder:${newFolder}`];
    await apiPost(`/blog/${blogName}/post/edit`, {
      id: postId,
      state: 'private',
      tags: newTags.join(','),
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// FOLDER MANAGEMENT
// ============================================================
async function getFolders() {
  const data = await chrome.storage.local.get('tf_folders');
  const folders = data.tf_folders || ['unsorted'];
  return { folders };
}

async function createFolder(name) {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
  const data = await chrome.storage.local.get('tf_folders');
  const folders = data.tf_folders || ['unsorted'];
  if (!folders.includes(sanitized)) {
    folders.push(sanitized);
    await chrome.storage.local.set({ tf_folders: folders });
  }
  return { success: true, folders, name: sanitized };
}

async function deleteFolder(name) {
  if (name === 'unsorted') return { success: false, error: 'Cannot delete unsorted folder' };
  const data = await chrome.storage.local.get('tf_folders');
  const folders = (data.tf_folders || []).filter(f => f !== name);
  await chrome.storage.local.set({ tf_folders: folders });
  return { success: true, folders };
}

async function getBlogInfo() {
  const data = await chrome.storage.local.get(['tf_access_token', 'tf_blog_name']);
  return { blogName: data.tf_blog_name };
}

// ============================================================
// POST NORMALIZER
// ============================================================
function normalizePost(post) {
  let image = null;
  if (post.type === 'photo' && post.photos?.[0]) {
    image = post.photos[0].alt_sizes?.[1]?.url || post.photos[0].original_size?.url;
  } else if (post.type === 'video') {
    image = post.thumbnail_url;
  }

  let textPreview = '';
  if (post.type === 'text') textPreview = post.summary || post.title || '';
  if (post.type === 'quote') textPreview = post.text || '';
  if (post.type === 'link') textPreview = post.title || post.url || '';
  if (post.type === 'answer') textPreview = post.question || '';

  const folderTag = (post.tags || []).find(t => t.startsWith('tf-folder:'));
  const folder = folderTag ? folderTag.replace('tf-folder:', '') : 'unsorted';

  return {
    id: post.id_string || String(post.id),
    type: post.type,
    url: post.post_url,
    blogName: post.blog_name,
    timestamp: post.timestamp,
    tags: post.tags || [],
    folder,
    image,
    textPreview,
    title: post.title || '',
    reblogCount: post.note_count || 0,
    summary: post.summary || textPreview,
  };
}

// ============================================================
// PKCE HELPERS
// ============================================================
function generateVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
