/**
 * French Class Worksheets — app.js
 *
 * Architecture:
 *   - Pure static SPA; all "backend" calls go to the GitHub Contents API.
 *   - Public visitors: read-only via unauthenticated API (60 req/hr).
 *   - Admin: authenticates with a GitHub Personal Access Token (repo scope).
 *     Token is kept only in sessionStorage (cleared on tab close).
 *   - Files are stored at:  worksheets/<YYYY-MM-DD>/<filename>
 */

/* ============================================================
   CONFIG
   ============================================================ */
const CFG = (() => {
    const c = window.FRENCH_CLASS_CONFIG || {};
    return {
        owner:  (c.REPO_OWNER || '').trim(),
        repo:   (c.REPO_NAME  || '').trim(),
        branch: (c.BRANCH     || 'main').trim(),
        base:   'worksheets'
    };
})();

/* ============================================================
   STATE
   ============================================================ */
const state = {
    token:      sessionStorage.getItem('fc_pat') || null,
    isAdmin:    false,
    currentDay: null,
    days:       [],          // string[] — directory names, sorted desc
    fileCache:  {},          // { [date]: GHFileItem[] }
};

/* ============================================================
   GITHUB API HELPERS
   ============================================================ */
const GH_BASE = 'https://api.github.com';

async function ghFetch(path, opts = {}) {
    const headers = {
        Accept: 'application/vnd.github.v3+json',
        ...(state.token ? { Authorization: `token ${state.token}` } : {}),
        ...(opts.headers || {})
    };
    return fetch(`${GH_BASE}${path}`, { ...opts, headers });
}

/** GET the contents of a repo path. Returns parsed JSON or null on 404. */
async function ghGetContents(repoPath) {
    const r = await ghFetch(
        `/repos/${CFG.owner}/${CFG.repo}/contents/${repoPath}?ref=${CFG.branch}`
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
    return r.json();
}

/** PUT (create or update) a file. content = base64 string. */
async function ghPutFile(repoPath, content, message, sha) {
    const body = { message, content, branch: CFG.branch };
    if (sha) body.sha = sha;
    const r = await ghFetch(
        `/repos/${CFG.owner}/${CFG.repo}/contents/${repoPath}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }
    );
    if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || `Upload failed (${r.status})`);
    }
    return r.json();
}

/** DELETE a file by its SHA. */
async function ghDeleteFile(repoPath, sha, message) {
    const r = await ghFetch(
        `/repos/${CFG.owner}/${CFG.repo}/contents/${repoPath}`,
        {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, sha, branch: CFG.branch })
        }
    );
    if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || `Delete failed (${r.status})`);
    }
}

/** Validate token by fetching the authenticated user. Returns username or throws. */
async function ghWhoAmI(token) {
    const r = await fetch(`${GH_BASE}/user`, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!r.ok) throw new Error('Invalid token or insufficient permissions.');
    const data = await r.json();
    return data.login;
}

/* ============================================================
   RAW DOWNLOAD URL
   ============================================================ */
function rawUrl(repoPath) {
    return `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/${repoPath}`;
}

/* ============================================================
   DATE HELPERS
   ============================================================ */
function fmtDateLong(iso) {          // "2024-01-15" → "Monday, January 15 2024"
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
}
function fmtDateShort(iso) {        // "2024-01-15" → "Jan 15"
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function todayIso() {
    const now = new Date();
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
    ].join('-');
}

/* ============================================================
   FILE TYPE HELPERS
   ============================================================ */
function fileExt(name) { return (name.split('.').pop() || '').toLowerCase(); }
function isPdf(name)   { return fileExt(name) === 'pdf'; }
function isImage(name) { return ['jpg','jpeg','png','gif','webp'].includes(fileExt(name)); }
function fileIcon(name) {
    if (isPdf(name))   return '📄';
    if (isImage(name)) return '🖼️';
    return '📎';
}
function fmtBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024)         return `${bytes} B`;
    if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
let toastTimer = null;
function toast(msg, type = '') {    // type: '' | 'error' | 'success'
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ` toast-${type}` : '');
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ============================================================
   MODAL HELPERS
   ============================================================ */
function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function backdropClose(e, id) { if (e.target === e.currentTarget) closeModal(id); }

/* ============================================================
   AUTH
   ============================================================ */
async function login() {
    const pat = document.getElementById('patInput').value.trim();
    if (!pat) { showLoginError('Please enter a token.'); return; }

    const btn = document.getElementById('loginBtnText');
    btn.textContent = 'Verifying…';

    try {
        const username = await ghWhoAmI(pat);
        // Optionally require token owner == repo owner
        // if (username.toLowerCase() !== CFG.owner.toLowerCase())
        //     throw new Error(`Token belongs to "${username}", not "${CFG.owner}".`);

        state.token   = pat;
        state.isAdmin = true;
        sessionStorage.setItem('fc_pat', pat);

        closeModal('loginModal');
        document.getElementById('patInput').value = '';
        applyAdminUI();
        toast(`Signed in as ${username}`, 'success');
    } catch (err) {
        showLoginError(err.message);
    } finally {
        btn.textContent = 'Sign in';
    }
}

function logout() {
    state.token   = null;
    state.isAdmin = false;
    sessionStorage.removeItem('fc_pat');
    applyAdminUI();
    // Re-render current day to remove admin controls
    if (state.currentDay) renderFiles(state.currentDay);
    toast('Logged out.');
}

function showLoginError(msg) {
    const el = document.getElementById('loginError');
    el.textContent = msg;
    el.classList.remove('hidden');
}

function applyAdminUI() {
    const isAdmin = state.isAdmin;
    document.getElementById('adminBtn').classList.toggle('hidden', isAdmin);
    document.getElementById('logoutBtn').classList.toggle('hidden', !isAdmin);
    document.getElementById('adminBadge').classList.toggle('hidden', !isAdmin);
    document.getElementById('addDayBtn').classList.toggle('hidden', !isAdmin);
    document.getElementById('uploadZone').classList.toggle('hidden', !isAdmin);
    document.getElementById('deleteDayBtn').classList.toggle('hidden', !isAdmin || !state.currentDay);
}

/* ============================================================
   LOAD DAYS  (sidebar)
   ============================================================ */
async function loadDays() {
    const list = document.getElementById('daysList');
    list.innerHTML = '<div class="sidebar-placeholder">Loading…</div>';

    if (!CFG.owner || !CFG.repo) {
        document.getElementById('configBanner').classList.remove('hidden');
        list.innerHTML = '<div class="sidebar-placeholder">Configure repo in config.js</div>';
        return;
    }

    try {
        const data = await ghGetContents(CFG.base);
        state.days = data
            ? data.filter(i => i.type === 'dir').map(i => i.name).sort((a,b) => b.localeCompare(a))
            : [];
    } catch (err) {
        toast(err.message, 'error');
        state.days = [];
    }

    renderDays();
}

function renderDays() {
    const list = document.getElementById('daysList');
    if (state.days.length === 0) {
        list.innerHTML = '<div class="sidebar-placeholder">No class days yet.</div>';
        return;
    }
    list.innerHTML = '';
    state.days.forEach(date => {
        const el = document.createElement('a');
        el.className = 'day-item' + (date === state.currentDay ? ' active' : '');
        el.href = '#';
        el.setAttribute('data-date', date);
        el.innerHTML = `
            <span class="day-item-label">${fmtDateShort(date)}</span>
            <span class="day-item-sub">${date}</span>`;
        el.addEventListener('click', e => { e.preventDefault(); selectDay(date); });
        list.appendChild(el);
    });
}

/* ============================================================
   SELECT / SHOW DAY
   ============================================================ */
async function selectDay(date) {
    state.currentDay = date;

    // Update sidebar highlight
    document.querySelectorAll('.day-item').forEach(el => {
        el.classList.toggle('active', el.dataset.date === date);
    });

    document.getElementById('welcomeScreen').classList.add('hidden');
    document.getElementById('dayView').classList.remove('hidden');
    document.getElementById('dayTitle').textContent = fmtDateLong(date);
    document.getElementById('daySubtitle').textContent = date;
    document.getElementById('deleteDayBtn').classList.toggle('hidden', !state.isAdmin);
    document.getElementById('uploadZone').classList.toggle('hidden', !state.isAdmin);
    document.getElementById('fileGrid').innerHTML = '<div class="sidebar-placeholder">Loading files…</div>';
    document.getElementById('emptyState').classList.add('hidden');

    await loadFiles(date);
}

/* ============================================================
   LOAD & RENDER FILES
   ============================================================ */
async function loadFiles(date) {
    if (!state.fileCache[date]) {
        try {
            const data = await ghGetContents(`${CFG.base}/${date}`);
            state.fileCache[date] = data ? data.filter(i => i.type === 'file') : [];
        } catch (err) {
            toast(err.message, 'error');
            state.fileCache[date] = [];
        }
    }
    renderFiles(date);
}

function renderFiles(date) {
    const grid  = document.getElementById('fileGrid');
    const empty = document.getElementById('emptyState');
    const files = state.fileCache[date] || [];

    grid.innerHTML = '';

    if (files.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    files.forEach(file => {
        const card = buildFileCard(file, date);
        grid.appendChild(card);
    });
}

function buildFileCard(file, date) {
    const path  = `${CFG.base}/${date}/${file.name}`;
    const url   = rawUrl(path);
    const isImg = isImage(file.name);
    const isPd  = isPdf(file.name);

    const card = document.createElement('div');
    card.className = 'file-card';

    // Thumbnail
    if (isImg) {
        card.innerHTML += `<img class="file-thumb" src="${url}" alt="${esc(file.name)}" loading="lazy" />`;
    } else {
        card.innerHTML += `<div class="file-thumb-placeholder">${fileIcon(file.name)}</div>`;
    }

    // Info
    card.innerHTML += `
        <div class="file-info">
            <div class="file-name" title="${esc(file.name)}">${esc(file.name)}</div>
            <div class="file-meta">${fmtBytes(file.size)}</div>
        </div>`;

    // Actions
    const actions = document.createElement('div');
    actions.className = 'file-actions';

    // View button
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn btn-outline-dark btn-sm';
    viewBtn.textContent = 'View';
    viewBtn.onclick = () => openFileViewer(url, file.name, isPd, isImg);
    actions.appendChild(viewBtn);

    // Download button
    const dlBtn = document.createElement('a');
    dlBtn.className = 'btn btn-outline-dark btn-sm';
    dlBtn.textContent = 'Download';
    dlBtn.href = url;
    dlBtn.download = file.name;
    actions.appendChild(dlBtn);

    // Delete (admin only)
    if (state.isAdmin) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger-outline btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.onclick = () => promptDeleteFile(file.name, file.sha, date);
        actions.appendChild(delBtn);
    }

    card.appendChild(actions);
    return card;
}

/* ============================================================
   FILE VIEWER
   ============================================================ */
function openFileViewer(url, name, isPd, isImg) {
    document.getElementById('viewTitle').textContent = name;
    const dlBtn = document.getElementById('viewDownloadBtn');
    dlBtn.href     = url;
    dlBtn.download = name;

    const body = document.getElementById('viewerContent');
    body.innerHTML = '';

    if (isPd) {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.title = name;
        body.appendChild(iframe);
    } else if (isImg) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        body.appendChild(img);
    } else {
        body.innerHTML = `<div style="padding:2rem;text-align:center;color:#fff">
            Preview not available. <a href="${esc(url)}" download style="color:#93c5fd">Download file</a>
        </div>`;
    }

    openModal('viewModal');
}

/* ============================================================
   ADD DAY
   ============================================================ */
function showAddDayForm() {
    document.getElementById('newDayDate').value = todayIso();
    document.getElementById('addDayForm').classList.remove('hidden');
    document.getElementById('newDayDate').focus();
}
function hideAddDayForm() {
    document.getElementById('addDayForm').classList.add('hidden');
}

function confirmAddDay() {
    const date = document.getElementById('newDayDate').value;
    if (!date) { toast('Please pick a date.', 'error'); return; }
    if (state.days.includes(date)) {
        toast('That day already exists.', 'error');
        selectDay(date);
        hideAddDayForm();
        return;
    }
    // Add to local list (no file yet → GitHub won't have the dir until first upload)
    state.days = [date, ...state.days].sort((a,b) => b.localeCompare(a));
    state.fileCache[date] = [];
    hideAddDayForm();
    renderDays();
    selectDay(date);
}

/* ============================================================
   DELETE DAY
   ============================================================ */
let _deleteDayPending = false;

async function confirmDeleteDay() {
    if (!state.currentDay) return;
    const date = state.currentDay;
    const files = state.fileCache[date] || [];

    if (files.length > 0) {
        if (!confirm(`Delete ALL ${files.length} file(s) in "${date}"? This cannot be undone.`)) return;
    } else {
        if (!confirm(`Remove class day "${date}" from the list?`)) return;
    }

    // Delete each file from GitHub
    for (const file of files) {
        try {
            await ghDeleteFile(
                `${CFG.base}/${date}/${file.name}`,
                file.sha,
                `Remove class day ${date}`
            );
        } catch (err) {
            toast(`Error deleting ${file.name}: ${err.message}`, 'error');
            return;
        }
    }

    // Remove from local state
    state.days = state.days.filter(d => d !== date);
    delete state.fileCache[date];
    state.currentDay = null;

    renderDays();
    document.getElementById('dayView').classList.add('hidden');
    document.getElementById('welcomeScreen').classList.remove('hidden');
    toast(`Class day ${date} deleted.`, 'success');
}

/* ============================================================
   FILE UPLOAD
   ============================================================ */
function onDragOver(e) {
    e.preventDefault();
    document.getElementById('uploadInner').classList.add('drag-over');
}
function onDragLeave(e) {
    document.getElementById('uploadInner').classList.remove('drag-over');
}
function onDrop(e) {
    e.preventDefault();
    document.getElementById('uploadInner').classList.remove('drag-over');
    handleFileInput(e.dataTransfer.files);
}
function handleFileInput(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    uploadFiles(files, state.currentDay);
}

async function uploadFiles(files, date) {
    const queue = document.getElementById('uploadQueue');
    queue.innerHTML = '';
    queue.classList.remove('hidden');

    for (const file of files) {
        const li = addQueueItem(queue, file.name);
        try {
            const base64 = await fileToBase64(file);

            // Check if file already exists (need SHA to update)
            const existing = await ghGetContents(`${CFG.base}/${date}/${file.name}`);
            const sha = existing?.sha;

            await ghPutFile(
                `${CFG.base}/${date}/${file.name}`,
                base64,
                `Add ${file.name} for ${date}`,
                sha
            );

            markQueueItem(li, 'done', 'Done');
        } catch (err) {
            markQueueItem(li, 'error', err.message);
        }
    }

    // Invalidate cache and re-render
    delete state.fileCache[date];
    if (!state.days.includes(date)) {
        state.days = [date, ...state.days].sort((a,b) => b.localeCompare(a));
        renderDays();
    }
    await loadFiles(date);

    setTimeout(() => queue.classList.add('hidden'), 2500);
    document.getElementById('fileInput').value = '';
}

function addQueueItem(queue, name) {
    const li = document.createElement('li');
    li.className = 'upload-item';
    li.innerHTML = `
        <span class="upload-item-name">${esc(name)}</span>
        <div class="progress-bar-wrap"><div class="progress-bar" style="width:60%"></div></div>
        <span class="upload-item-status status-uploading">Uploading…</span>`;
    queue.appendChild(li);
    return li;
}
function markQueueItem(li, type, msg) {
    const bar  = li.querySelector('.progress-bar-wrap');
    const stat = li.querySelector('.upload-item-status');
    if (bar)  bar.remove();
    stat.className = `upload-item-status status-${type}`;
    stat.textContent = msg;
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsDataURL(file);
    });
}

/* ============================================================
   DELETE FILE (admin)
   ============================================================ */
let _pendingDelete = null;

function promptDeleteFile(filename, sha, date) {
    _pendingDelete = { filename, sha, date };
    document.getElementById('confirmFileName').textContent = filename;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.onclick = executeDeleteFile;
    openModal('confirmModal');
}

async function executeDeleteFile() {
    if (!_pendingDelete) return;
    const { filename, sha, date } = _pendingDelete;
    _pendingDelete = null;
    closeModal('confirmModal');

    try {
        await ghDeleteFile(
            `${CFG.base}/${date}/${filename}`,
            sha,
            `Delete ${filename} from ${date}`
        );
        delete state.fileCache[date];
        await loadFiles(date);
        toast(`"${filename}" deleted.`, 'success');
    } catch (err) {
        toast(err.message, 'error');
    }
}

/* ============================================================
   SAFE HTML ESCAPING
   ============================================================ */
function esc(str) {
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ============================================================
   PUBLIC API  (called from HTML via onclick)
   ============================================================ */
window.App = {
    openLoginModal() { document.getElementById('loginError').classList.add('hidden'); openModal('loginModal'); },
    closeModal,
    backdropClose,
    login,
    logout,
    showAddDayForm,
    hideAddDayForm,
    confirmAddDay,
    confirmDeleteDay,
    onDragOver,
    onDragLeave,
    onDrop,
    handleFileInput,
};

/* ============================================================
   BOOT
   ============================================================ */
(async function init() {
    // Restore admin session if token is in sessionStorage
    if (state.token) {
        try {
            await ghWhoAmI(state.token);
            state.isAdmin = true;
        } catch {
            sessionStorage.removeItem('fc_pat');
            state.token = null;
        }
    }
    applyAdminUI();
    await loadDays();
})();
