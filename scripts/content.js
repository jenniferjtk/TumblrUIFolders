// ============================================================
// content.js — Injected into tumblr.com
// Builds the sidebar UI and injects save buttons on posts
// ============================================================

(function () {
  if (document.getElementById('tf-sidebar')) return; // already injected

  // ============================================================
  // STATE
  // ============================================================
  let state = {
    authenticated: false,
    blogName: null,
    folders: ['unsorted'],
    activeFolder: 'unsorted',
    folderPosts: {},      // { folderName: [post, ...] }
    view: 'folders',      // 'folders' | 'migrate'
    migrating: false,
    migrateTotal: 0,
    migrateDone: 0,
    drafts: [],
  };

  // ============================================================
  // MESSAGING
  // ============================================================
  function send(type, data = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...data }, resolve);
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    buildSidebar();
    const status = await send('GET_AUTH_STATUS');
    if (status.authenticated) {
      state.authenticated = true;
      state.blogName = status.blogName;
      await loadFolders();
      renderFolderList();
      showFolderView();
      injectSaveButtons();
      observeFeed();
    } else if (status.hasCredentials) {
      showAuthView();
    } else {
      showSetupView();
    }
  }

  // ============================================================
  // SIDEBAR SHELL
  // ============================================================
  function buildSidebar() {
    const sidebar = document.createElement('div');
    sidebar.id = 'tf-sidebar';
    sidebar.innerHTML = `
      <div id="tf-header">
        <div id="tf-logo">folders<span>.</span></div>
        <button id="tf-add-folder-btn" title="New folder">+</button>
      </div>
      <div id="tf-sidebar-body"></div>
    `;
    document.body.appendChild(sidebar);

    // Push Tumblr content right
    nudgeTumblrLayout();

    document.getElementById('tf-add-folder-btn').addEventListener('click', promptNewFolder);
  }

  function nudgeTumblrLayout() {
    // Try common Tumblr layout containers
    const selectors = [
      '#base-container',
      '.base-container',
      'div[data-js-target="content"]',
      'main',
      '#root',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.style.marginLeft = '260px';
        el.style.transition = 'margin-left 0.25s ease';
        break;
      }
    }
  }

  function setBody(html) {
    document.getElementById('tf-sidebar-body').innerHTML = html;
  }

  // ============================================================
  // SETUP VIEW (first run — enter API credentials)
  // ============================================================
  function showSetupView() {
    setBody(`
      <div class="tf-auth-view">
        <div class="tf-auth-icon">🔑</div>
        <h2>Setup</h2>
        <p>Register a free Tumblr app to get your credentials, then paste them below.</p>
        <a class="tf-setup-link" href="https://www.tumblr.com/oauth/apps" target="_blank">
          Open tumblr.com/oauth/apps →
        </a>
        <div class="tf-setup-field">
          <label>Consumer Key (Client ID)</label>
          <input type="text" id="tf-client-id" placeholder="Paste your consumer key" autocomplete="off" spellcheck="false" />
        </div>
        <div class="tf-setup-field">
          <label>Consumer Secret</label>
          <input type="password" id="tf-client-secret" placeholder="Paste your consumer secret" autocomplete="off" />
        </div>
        <div class="tf-setup-redirect">
          <label>Set this as your OAuth Redirect URL in your Tumblr app:</label>
          <code id="tf-redirect-uri">Loading…</code>
          <button class="tf-copy-btn" id="tf-copy-redirect">Copy</button>
        </div>
        <button class="tf-btn tf-btn-primary" id="tf-save-creds-btn">Save & Connect</button>
        <p class="tf-auth-note">Credentials are stored only on your device. Never in the code or on any server.</p>
      </div>
    `);

    // Show the redirect URI they need to set in their Tumblr app
    chrome.runtime.sendMessage({ type: 'GET_REDIRECT_URI' }, (res) => {
      const el = document.getElementById('tf-redirect-uri');
      if (el && res?.uri) el.textContent = res.uri;
    });

    document.getElementById('tf-copy-redirect').addEventListener('click', () => {
      const uri = document.getElementById('tf-redirect-uri').textContent;
      navigator.clipboard.writeText(uri).then(() => showToast('Copied!'));
    });

    document.getElementById('tf-save-creds-btn').addEventListener('click', async () => {
      const clientId = document.getElementById('tf-client-id').value.trim();
      const clientSecret = document.getElementById('tf-client-secret').value.trim();
      if (!clientId || !clientSecret) {
        showToast('Both fields are required', 'error');
        return;
      }
      const btn = document.getElementById('tf-save-creds-btn');
      btn.textContent = 'Saving…';
      btn.disabled = true;
      const res = await send('SAVE_CREDENTIALS', { clientId, clientSecret });
      if (res.success) {
        showAuthView();
      } else {
        showToast(res.error || 'Failed to save', 'error');
        btn.textContent = 'Save & Connect';
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // AUTH VIEW (credentials saved, now connect account)
  // ============================================================
  function showAuthView() {
    setBody(`
      <div class="tf-auth-view">
        <div class="tf-auth-icon">📁</div>
        <h2>Tumblr Folders</h2>
        <p>Save posts into folders that sync everywhere — even on mobile.</p>
        <button class="tf-btn tf-btn-primary" id="tf-login-btn">Connect Tumblr Account</button>
        <button class="tf-btn tf-btn-ghost" id="tf-reset-creds-btn" style="margin-top:6px">Change API credentials</button>
        <p class="tf-auth-note">Uses OAuth 2.0 — your password is never shared with this extension.</p>
      </div>
    `);
    document.getElementById('tf-login-btn').addEventListener('click', doLogin);
    document.getElementById('tf-reset-creds-btn').addEventListener('click', async () => {
      await send('CLEAR_CREDENTIALS');
      showSetupView();
    });
  }

  async function doLogin() {
    const btn = document.getElementById('tf-login-btn');
    btn.textContent = 'Connecting…';
    btn.disabled = true;
    const result = await send('OAUTH_LOGIN');
    if (result.success) {
      state.authenticated = true;
      state.blogName = result.blogName;
      await loadFolders();
      renderFolderList();
      showFolderView();
      injectSaveButtons();
      observeFeed();
    } else {
      btn.textContent = 'Connect Tumblr Account';
      btn.disabled = false;
      showToast('Login failed: ' + result.error, 'error');
    }
  }

  // ============================================================
  // FOLDER VIEW
  // ============================================================
  async function loadFolders() {
    const res = await send('GET_FOLDERS');
    state.folders = res.folders || ['unsorted'];
  }

  function showFolderView() {
    state.view = 'folders';
    setBody(`
      <div class="tf-folder-view">
        <div id="tf-folder-list"></div>
        <div id="tf-post-grid-area"></div>
      </div>
    `);
    renderFolderList();

    // Check if migration needed
    checkForDrafts();
  }

  function renderFolderList() {
    const container = document.getElementById('tf-folder-list');
    if (!container) return;

    container.innerHTML = state.folders.map(folder => `
      <div class="tf-folder-item ${folder === state.activeFolder ? 'active' : ''}"
           data-folder="${folder}">
        <span class="tf-folder-icon">${folder === 'unsorted' ? '📥' : '📁'}</span>
        <span class="tf-folder-name">${folder === 'unsorted' ? 'Unsorted' : folder}</span>
        ${folder !== 'unsorted' ? `<button class="tf-folder-delete" data-folder="${folder}" title="Delete folder">×</button>` : ''}
      </div>
    `).join('');

    container.querySelectorAll('.tf-folder-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tf-folder-delete')) return;
        openFolder(el.dataset.folder);
      });
    });

    container.querySelectorAll('.tf-folder-delete').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDeleteFolder(el.dataset.folder);
      });
    });
  }

  async function openFolder(folderName) {
    state.activeFolder = folderName;
    renderFolderList();
    showLoadingGrid();

    const res = await send('FETCH_PRIVATE_POSTS', {
      blogName: state.blogName,
      tag: folderName,
    });

    if (res.success) {
      state.folderPosts[folderName] = res.posts;
      renderPostGrid(res.posts, folderName);
    } else {
      showGridError(res.error);
    }
  }

  function showLoadingGrid() {
    const area = document.getElementById('tf-post-grid-area');
    if (!area) return;
    area.innerHTML = `<div class="tf-grid-loading">Loading posts…</div>`;
  }

  function showGridError(msg) {
    const area = document.getElementById('tf-post-grid-area');
    if (!area) return;
    area.innerHTML = `<div class="tf-grid-error">Error: ${msg}</div>`;
  }

  function renderPostGrid(posts, folderName) {
    const area = document.getElementById('tf-post-grid-area');
    if (!area) return;

    if (posts.length === 0) {
      area.innerHTML = `
        <div class="tf-empty-folder">
          <div class="tf-empty-icon">${folderName === 'unsorted' ? '📥' : '📁'}</div>
          <p>${folderName === 'unsorted' ? 'No unsorted posts.' : 'This folder is empty.'}</p>
          ${folderName === 'unsorted' ? '<p class="tf-empty-sub">Hit the save button on any post to add it here.</p>' : ''}
        </div>`;
      return;
    }

    area.innerHTML = `
      <div class="tf-grid-header">
        <span class="tf-grid-title">${folderName === 'unsorted' ? 'Unsorted' : folderName}</span>
        <span class="tf-grid-count">${posts.length} posts</span>
      </div>
      <div class="tf-post-grid">
        ${posts.map(post => renderPostCard(post)).join('')}
      </div>
    `;

    // Attach move-to-folder handlers
    area.querySelectorAll('.tf-card-move').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showMovePicker(btn.dataset.postId, folderName, btn);
      });
    });
  }

  function renderPostCard(post) {
    const img = post.image
      ? `<div class="tf-card-img" style="background-image:url('${post.image}')"></div>`
      : `<div class="tf-card-img tf-card-img-text"><span>${post.textPreview || post.type}</span></div>`;

    return `
      <div class="tf-post-card" data-post-id="${post.id}">
        <a href="${post.url}" target="_blank" class="tf-card-link">
          ${img}
          <div class="tf-card-meta">
            <span class="tf-card-blog">${post.blogName}</span>
            <span class="tf-card-type">${post.type}</span>
          </div>
        </a>
        <button class="tf-card-move" data-post-id="${post.id}" title="Move to folder">⤴</button>
      </div>
    `;
  }

  // ============================================================
  // MIGRATE DRAFTS
  // ============================================================
  async function checkForDrafts() {
    // Show migrate banner if user hasn't dismissed it
    const data = await chrome.storage.local.get('tf_migrate_dismissed');
    if (data.tf_migrate_dismissed) return;

    // Peek at drafts count
    const res = await send('FETCH_DRAFTS', { blogName: state.blogName });
    if (res.success && res.count > 0) {
      showMigrateBanner(res.count, res.drafts);
    }
  }

  function showMigrateBanner(count, drafts) {
    const area = document.getElementById('tf-post-grid-area');
    if (!area) return;

    area.innerHTML = `
      <div class="tf-migrate-banner">
        <div class="tf-migrate-icon">📬</div>
        <h3>You have ${count} drafts</h3>
        <p>Convert them all to private posts so they appear in your folders — including on mobile.</p>
        <div class="tf-migrate-actions">
          <button class="tf-btn tf-btn-primary" id="tf-migrate-btn">Migrate All Drafts</button>
          <button class="tf-btn tf-btn-ghost" id="tf-migrate-dismiss">Not now</button>
        </div>
      </div>
    `;

    document.getElementById('tf-migrate-btn').addEventListener('click', () => startMigration(drafts));
    document.getElementById('tf-migrate-dismiss').addEventListener('click', () => {
      chrome.storage.local.set({ tf_migrate_dismissed: true });
      area.innerHTML = '';
    });
  }

  async function startMigration(drafts) {
    const area = document.getElementById('tf-post-grid-area');
    const postIds = drafts.map(d => d.id);
    state.migrating = true;
    state.migrateTotal = postIds.length;
    state.migrateDone = 0;

    area.innerHTML = `
      <div class="tf-migrate-progress">
        <div class="tf-migrate-icon">⚙️</div>
        <h3>Migrating drafts…</h3>
        <div class="tf-progress-bar"><div class="tf-progress-fill" id="tf-progress-fill"></div></div>
        <p id="tf-progress-label">0 / ${postIds.length}</p>
        <p class="tf-migrate-note">This may take a minute. Don't close this tab.</p>
      </div>
    `;

    // Migrate in batches, updating progress
    const BATCH = 5;
    for (let i = 0; i < postIds.length; i += BATCH) {
      const batch = postIds.slice(i, i + BATCH);
      await send('MIGRATE_DRAFTS', { blogName: state.blogName, postIds: batch });
      state.migrateDone = Math.min(i + BATCH, postIds.length);
      const pct = Math.round((state.migrateDone / state.migrateTotal) * 100);
      const fill = document.getElementById('tf-progress-fill');
      const label = document.getElementById('tf-progress-label');
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = `${state.migrateDone} / ${state.migrateTotal}`;
    }

    await chrome.storage.local.set({ tf_migrate_dismissed: true });
    area.innerHTML = `
      <div class="tf-migrate-done">
        <div class="tf-migrate-icon">✅</div>
        <h3>All done!</h3>
        <p>${postIds.length} posts moved to your <strong>Unsorted</strong> folder.</p>
        <button class="tf-btn tf-btn-primary" id="tf-open-unsorted">Browse & Sort</button>
      </div>
    `;
    document.getElementById('tf-open-unsorted').addEventListener('click', () => openFolder('unsorted'));
  }

  // ============================================================
  // NEW FOLDER
  // ============================================================
  async function promptNewFolder() {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    const res = await send('CREATE_FOLDER', { name: name.trim() });
    if (res.success) {
      state.folders = res.folders;
      renderFolderList();
      showToast(`Folder "${res.name}" created`);
    }
  }

  async function confirmDeleteFolder(name) {
    if (!confirm(`Delete folder "${name}"? Posts will stay as private posts but lose their folder tag.`)) return;
    const res = await send('DELETE_FOLDER', { name });
    if (res.success) {
      state.folders = res.folders;
      if (state.activeFolder === name) state.activeFolder = 'unsorted';
      renderFolderList();
      showToast(`Folder "${name}" deleted`);
    }
  }

  // ============================================================
  // MOVE POST TO FOLDER PICKER
  // ============================================================
  function showMovePicker(postId, currentFolder, anchorBtn) {
    // Remove any existing picker
    document.querySelectorAll('.tf-move-picker').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'tf-move-picker';
    picker.innerHTML = `
      <div class="tf-picker-label">Move to folder:</div>
      ${state.folders
        .filter(f => f !== currentFolder)
        .map(f => `<button class="tf-picker-option" data-folder="${f}">${f === 'unsorted' ? '📥 Unsorted' : '📁 ' + f}</button>`)
        .join('')}
    `;

    document.body.appendChild(picker);

    // Position near button
    const rect = anchorBtn.getBoundingClientRect();
    picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
    picker.style.left = `${rect.left + window.scrollX - 120}px`;

    picker.querySelectorAll('.tf-picker-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        picker.remove();
        const folder = btn.dataset.folder;
        const res = await send('ASSIGN_FOLDER', {
          blogName: state.blogName,
          postId,
          folder,
          previousFolder: currentFolder,
        });
        if (res.success) {
          showToast(`Moved to "${folder}"`);
          // Remove card from current view
          document.querySelector(`[data-post-id="${postId}"]`)?.remove();
        } else {
          showToast('Failed to move post', 'error');
        }
      });
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', () => picker.remove(), { once: true });
    }, 0);
  }

  // ============================================================
  // INJECT SAVE BUTTONS ON FEED POSTS
  // ============================================================
  function injectSaveButtons() {
    const posts = document.querySelectorAll('article[data-id], [data-id][role="article"]');
    posts.forEach(injectSaveButton);
  }

  function injectSaveButton(postEl) {
    if (postEl.querySelector('.tf-save-btn')) return; // already has one

    const postId = postEl.dataset.id || postEl.getAttribute('data-id');
    const postUrl = postEl.querySelector('a[href*="/post/"]')?.href || window.location.href;

    const btn = document.createElement('button');
    btn.className = 'tf-save-btn';
    btn.title = 'Save to folder';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
    `;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFeedSavePicker(postUrl, btn);
    });

    // Try to append to post's action buttons, else append to post itself
    const actions = postEl.querySelector('[data-id] footer, footer, .post-footer, [class*="Footer"]');
    if (actions) {
      actions.appendChild(btn);
    } else {
      btn.style.position = 'absolute';
      btn.style.top = '8px';
      btn.style.right = '8px';
      postEl.style.position = 'relative';
      postEl.appendChild(btn);
    }
  }

  function showFeedSavePicker(postUrl, anchorBtn) {
    document.querySelectorAll('.tf-save-picker').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'tf-save-picker tf-move-picker';
    picker.innerHTML = `
      <div class="tf-picker-label">Save to folder:</div>
      ${state.folders.map(f => `
        <button class="tf-picker-option" data-folder="${f}">
          ${f === 'unsorted' ? '📥 Unsorted' : '📁 ' + f}
        </button>
      `).join('')}
    `;

    document.body.appendChild(picker);

    const rect = anchorBtn.getBoundingClientRect();
    picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
    picker.style.left = `${rect.left + window.scrollX - 140}px`;

    picker.querySelectorAll('.tf-picker-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        picker.remove();
        const folder = btn.dataset.folder;
        anchorBtn.innerHTML = '⏳';
        anchorBtn.disabled = true;

        const res = await send('SAVE_POST_TO_FOLDER', {
          blogName: state.blogName,
          postUrl,
          folder,
        });

        if (res.success) {
          anchorBtn.innerHTML = '✓';
          anchorBtn.classList.add('tf-save-btn-done');
          showToast(`Saved to "${folder}"`);
        } else {
          anchorBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
          anchorBtn.disabled = false;
          showToast('Failed to save: ' + res.error, 'error');
        }
      });
    });

    setTimeout(() => {
      document.addEventListener('click', () => picker.remove(), { once: true });
    }, 0);
  }

  // ============================================================
  // OBSERVE FEED FOR NEW POSTS (infinite scroll)
  // ============================================================
  function observeFeed() {
    const observer = new MutationObserver(() => {
      if (state.authenticated) injectSaveButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // TOAST NOTIFICATIONS
  // ============================================================
  function showToast(msg, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `tf-toast tf-toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('tf-toast-show'), 10);
    setTimeout(() => {
      toast.classList.remove('tf-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // ============================================================
  // BOOT
  // ============================================================
  init();
})();
