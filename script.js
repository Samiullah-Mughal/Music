// ═══════════════════════════════════════════════════════════
//  PERSISTENCE — localStorage as base64
//  Songs stored as: { id, name, title, artist, duration, mimeType, b64 }
//  URL is re-created from b64 on load (ObjectURL)
// ═══════════════════════════════════════════════════════════
const SONGS_KEY  = 'wave_songs_v3';
const RECENT_KEY = 'wave_recent_v3';
const LIKED_KEY  = 'wave_liked_v3';

let songStore = [];   // runtime array (includes .url)
let recentIds  = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
let likedIds   = new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'));

function b64toObjectURL(b64, mime) {
  try {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime }));
  } catch(e) { return null; }
}

function loadSongsFromStorage() {
  try {
    const raw = localStorage.getItem(SONGS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    arr.forEach(s => {
      const url = b64toObjectURL(s.b64, s.mimeType);
      if (url) songStore.push({ ...s, url });
    });
  } catch(e) { console.warn('Storage load error:', e); }
}

function persistSongs() {
  const toSave = songStore.map(({ url, ...rest }) => rest);
  try {
    localStorage.setItem(SONGS_KEY, JSON.stringify(toSave));
  } catch(e) {
    if (e.name === 'QuotaExceededError' && songStore.length > 1) {
      // Drop oldest and retry
      songStore.shift();
      persistSongs();
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  FILE IMPORT
// ═══════════════════════════════════════════════════════════
function parseName(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const parts = base.split(/\s*[-–—]\s*/);
  return parts.length >= 2
    ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
    : { artist: 'Unknown Artist', title: base.trim() };
}

function getDuration(url) {
  return new Promise(res => {
    const a = new Audio();
    a.src = url;
    a.onloadedmetadata = () => res(a.duration || 0);
    a.onerror = () => res(0);
    setTimeout(() => res(0), 3000);
  });
}

function readAsB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function showToast(msg) {
  const t = document.getElementById('importToast');
  t.textContent = msg; t.style.display = 'block';
}
function hideToast(msg) {
  const t = document.getElementById('importToast');
  if (msg) t.textContent = msg;
  setTimeout(() => { t.style.display = 'none'; }, 1600);
}

async function importFiles(files) {
  if (!files || !files.length) return;
  const arr = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a|opus|wma)$/i.test(f.name));
  if (!arr.length) { showToast('⚠️ No audio files found'); hideToast(); return; }

  showToast(`⬆ Importing 0 / ${arr.length}…`);
  let imported = 0;

  for (let i = 0; i < arr.length; i++) {
    const file = arr[i];
    showToast(`⬆ ${i + 1} / ${arr.length}: ${file.name.slice(0, 28)}…`);

    // Skip duplicates
    if (songStore.find(s => s.name === file.name)) continue;

    try {
      const b64  = await readAsB64(file);
      const url  = b64toObjectURL(b64, file.type || 'audio/mpeg');
      const dur  = await getDuration(url);
      const { artist, title } = parseName(file.name);
      const id   = Date.now() + Math.random();
      songStore.push({ id, name: file.name, title, artist, duration: dur, mimeType: file.type || 'audio/mpeg', b64, url });
      imported++;
    } catch(e) { console.warn('Import failed:', file.name, e); }
  }

  persistSongs();
  hideToast(imported ? `✅ Imported ${imported} song${imported > 1 ? 's' : ''}` : '⚠️ Already in library');
  renderAll();
}

// Wire file inputs
function wireInputs() {
  const bind = id => document.getElementById(id).addEventListener('change', e => importFiles(e.target.files));
  bind('fileInput'); bind('emptyFileInput');

  const zone = document.getElementById('uploadZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); importFiles(e.dataTransfer.files); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });
}

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
const state = { idx: 0, playing: false, shuffle: false, repeat: false, volume: 0.7 };
const audio = document.getElementById('audioPlayer');
audio.volume = state.volume;

// ═══════════════════════════════════════════════════════════
//  AUDIO CONTEXT + VISUALIZER
// ═══════════════════════════════════════════════════════════
let actx, analyser, mediaSource;

function initAudioCtx() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = actx.createAnalyser();
  analyser.fftSize = 128;
  mediaSource = actx.createMediaElementSource(audio);
  mediaSource.connect(analyser);
  analyser.connect(actx.destination);
}

const canvas = document.getElementById('visualizer');
const ctx2d  = canvas.getContext('2d');

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = canvas.offsetWidth  * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx2d.scale(dpr, dpr);
}

(function drawViz() {
  requestAnimationFrame(drawViz);
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  ctx2d.clearRect(0, 0, W, H);
  const bars = 40, bw = W / bars, t = Date.now() / 1000;

  if (!analyser || !state.playing) {
    for (let i = 0; i < bars; i++) {
      const h = (Math.sin(t * 1.6 + i * 0.38) * 0.5 + 0.5) * 9 + 2;
      ctx2d.fillStyle = 'rgba(124,111,255,0.13)';
      ctx2d.beginPath(); ctx2d.roundRect(i * bw + bw * 0.1, H/2 - h/2, bw * 0.72, h, 2); ctx2d.fill();
    }
    return;
  }

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const step = Math.max(1, Math.floor(data.length / bars));
  for (let i = 0; i < bars; i++) {
    const v = data[i * step] / 255;
    const h = Math.max(3, v * (H - 6));
    ctx2d.fillStyle = `hsla(${250 + v * 70},75%,65%,${0.3 + v * 0.7})`;
    ctx2d.beginPath(); ctx2d.roundRect(i * bw + bw * 0.1, H - h - 2, bw * 0.72, h, 3); ctx2d.fill();
  }
})();

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════
const EMOJIS = ['🎵','🎶','🎸','🎹','🥁','🎺','🎻','🎷','🎤','🎧'];
function songEmoji(s) { return EMOJIS[Math.abs((s.title.charCodeAt(0) || 0) + (s.artist.charCodeAt(0) || 0)) % EMOJIS.length]; }
function fmt(s) { if (!s || isNaN(s)) return '0:00'; const m = Math.floor(s/60), ss = Math.floor(s%60); return `${m}:${ss.toString().padStart(2,'0')}`; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function curSong() { return songStore[state.idx] || null; }

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════
function renderAll() {
  renderLibrary();
  renderSongList();
  renderHero();
  renderBar();
  renderControls();
  renderRecentSidebar();
  const has = songStore.length > 0;
  document.getElementById('emptyState').style.display      = has ? 'none' : 'flex';
  document.getElementById('songListHeader').style.display  = has ? 'grid' : 'none';
  document.getElementById('queueTitle').textContent = `My Library (${songStore.length})`;
}

function renderLibrary() {
  document.getElementById('libraryList').innerHTML = `
    <div class="playlist-item active">
      <div class="playlist-thumb">🎵</div>
      <div class="playlist-info">
        <div class="playlist-name">All Songs</div>
        <div class="playlist-count">${songStore.length} tracks</div>
      </div>
    </div>`;
}

function renderSongList() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const list = q ? songStore.filter(s => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)) : songStore;
  document.getElementById('songList').innerHTML = list.map(song => {
    const ri = songStore.indexOf(song), active = ri === state.idx;
    return `<div class="song-row ${active ? 'active' : ''}" onclick="playSong(${ri})">
      <div class="song-num">${active && state.playing ? '♪' : ri + 1}</div>
      <div class="song-info-cell">
        <div class="song-mini-art">${songEmoji(song)}</div>
        <div>
          <div class="song-name">${esc(song.title)}</div>
          <div class="song-artist-small">${esc(song.artist)}</div>
        </div>
      </div>
      <div class="song-duration">${fmt(song.duration)}</div>
    </div>`;
  }).join('') || (q ? `<div style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">No results for "${esc(q)}"</div>` : '');
}

function renderHero() {
  const s = curSong();
  document.getElementById('heroEmoji').textContent  = s ? songEmoji(s) : '🎵';
  document.getElementById('heroArt').classList.toggle('playing', !!(s && state.playing));
  document.getElementById('heroTitle').textContent  = s ? s.title  : 'No song loaded';
  document.getElementById('heroArtist').textContent = s ? s.artist : 'Import music to begin';
  document.getElementById('heroFormat').textContent = s ? (s.mimeType.split('/')[1] || 'AUDIO').toUpperCase() : 'WAVE';
}

function renderBar() {
  const s = curSong();
  document.getElementById('barEmoji').textContent = s ? songEmoji(s) : '🎵';
  document.getElementById('barArt').classList.toggle('spinning', !!(s && state.playing));
  document.getElementById('barSong').textContent   = s ? s.title  : 'No song selected';
  document.getElementById('barArtist').textContent = s ? s.artist : '—';
  const h = document.getElementById('heartBtn');
  const liked = s && likedIds.has(s.id);
  h.textContent = liked ? '♥' : '♡';
  h.classList.toggle('liked', liked);
}

function renderControls() {
  const playImg = document.querySelector('#playBtn img');
  if (playImg) {
    playImg.src = state.playing ? 'icons/pause.png' : 'icons/play.png';
    playImg.alt = state.playing ? 'Pause' : 'Play';
  }
  document.getElementById('shuffleBtn').classList.toggle('active', state.shuffle);
  const rb = document.getElementById('repeatBtn');
  rb.classList.toggle('active', !!state.repeat);
  rb.setAttribute('data-repeat', state.repeat || 'off');
  const repeatImg = rb.querySelector('img');
  if (repeatImg) {
    repeatImg.alt = state.repeat === 'one' ? 'Repeat Once' : state.repeat === 'all' ? 'Repeat All' : 'Repeat';
  }
}

function renderRecentSidebar() {
  document.getElementById('recentSidebar').innerHTML =
    recentIds.slice(0,4).map(id => {
      const s = songStore.find(x => x.id == id);
      if (!s) return '';
      return `<div class="playlist-item" onclick="jumpById(${s.id})">
        <div class="playlist-thumb">${songEmoji(s)}</div>
        <div class="playlist-info">
          <div class="playlist-name">${esc(s.title)}</div>
          <div class="playlist-count">${esc(s.artist)}</div>
        </div>
      </div>`;
    }).join('') || '<div style="font-size:11px;color:var(--text-dim);padding:4px 12px 8px">Nothing yet</div>';
}

// ═══════════════════════════════════════════════════════════
//  PLAYBACK
// ═══════════════════════════════════════════════════════════
function playSong(idx) {
  if (idx < 0 || idx >= songStore.length) return;
  state.idx = idx;
  const s = songStore[idx];
  initAudioCtx();
  if (actx.state === 'suspended') actx.resume();
  audio.src = s.url;
  audio.volume = state.volume;
  audio.play().catch(e => { console.warn('Play error:', e); state.playing = false; renderAll(); });
  state.playing = true;

  // Recently played
  recentIds = [s.id, ...recentIds.filter(x => x != s.id)].slice(0, 20);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
  localStorage.setItem('wave_lastSong', s.id);

  renderAll();
  if (window.innerWidth <= 768) closeSidebar();
}

function jumpById(id) {
  const i = songStore.findIndex(s => s.id == id);
  if (i !== -1) playSong(i);
}

function togglePlay() {
  if (songStore.length === 0) return;
  if (!audio.src || audio.src === location.href) { playSong(state.idx); return; }
  if (state.playing) { audio.pause(); }
  else { initAudioCtx(); if (actx.state === 'suspended') actx.resume(); audio.play(); }
}

function nextSong() {
  if (!songStore.length) return;
  if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  let next;
  if (state.shuffle) {
    do { next = Math.floor(Math.random() * songStore.length); } while (songStore.length > 1 && next === state.idx);
  } else {
    next = (state.idx + 1) % songStore.length;
    if (next === 0 && !state.repeat) { audio.pause(); state.playing = false; renderAll(); return; }
  }
  playSong(next);
}

function prevSong() {
  if (!songStore.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playSong((state.idx - 1 + songStore.length) % songStore.length);
}

// Audio events
audio.addEventListener('ended', nextSong);
audio.addEventListener('play',  () => { state.playing = true;  renderAll(); });
audio.addEventListener('pause', () => { state.playing = false; renderAll(); });
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  const bar = document.getElementById('progressBar');
  bar.value = pct;
  bar.style.background = `linear-gradient(to right,var(--accent) ${pct}%,var(--surface3) ${pct}%)`;
  document.getElementById('currentTime').textContent = fmt(audio.currentTime);
  document.getElementById('totalTime').textContent   = fmt(audio.duration);
});

// ═══════════════════════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════════════════════
document.getElementById('playBtn').onclick  = togglePlay;
document.getElementById('nextBtn').onclick  = nextSong;
document.getElementById('prevBtn').onclick  = prevSong;

document.getElementById('shuffleBtn').onclick = () => { state.shuffle = !state.shuffle; renderControls(); };
document.getElementById('repeatBtn').onclick  = () => {
  state.repeat = !state.repeat ? 'all' : state.repeat === 'all' ? 'one' : false; renderControls();
};
document.getElementById('heartBtn').onclick = () => {
  const s = curSong(); if (!s) return;
  likedIds.has(s.id) ? likedIds.delete(s.id) : likedIds.add(s.id);
  localStorage.setItem(LIKED_KEY, JSON.stringify([...likedIds]));
  renderBar();
};
document.getElementById('progressBar').addEventListener('input', e => {
  if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
});
document.getElementById('volumeBar').addEventListener('input', e => {
  state.volume = e.target.value / 100; audio.volume = state.volume;
  const b = document.getElementById('volumeBar');
  b.style.background = `linear-gradient(to right,var(--accent3) ${e.target.value}%,var(--surface3) ${e.target.value}%)`;
  const volIcon = document.getElementById('volIcon');
  if (state.volume === 0) {
    volIcon.src = 'icons/volume-disabled.png';
    volIcon.alt = 'Muted';
  } else if (state.volume < 0.5) {
    volIcon.src = 'icons/volume.png';
    volIcon.alt = 'Volume Low';
  } else {
    volIcon.src = 'icons/volume full.png';
    volIcon.alt = 'Volume High';
  }
});
document.getElementById('searchInput').addEventListener('input', renderSongList);
document.getElementById('themeBtn').onclick = () => {
  document.body.classList.toggle('light');
  const themeBtnImg = document.querySelector('#themeBtn img');
  if (themeBtnImg) {
    themeBtnImg.src = document.body.classList.contains('light') ? 'icons/light.png' : 'icons/dark.png';
    themeBtnImg.alt = document.body.classList.contains('light') ? 'Light Mode' : 'Dark Mode';
  }
};
document.getElementById('recentBtn').onclick = openRecent;

function openRecent() {
  document.getElementById('recentList').innerHTML = recentIds.slice(0,15).map((id, i) => {
    const s = songStore.find(x => x.id == id); if (!s) return '';
    return `<div class="recent-row" onclick="jumpById(${s.id});closeModal('recentOverlay')">
      <div class="recent-num">${i+1}</div>
      <div class="recent-art">${songEmoji(s)}</div>
      <div class="recent-info"><div class="recent-song">${esc(s.title)}</div><div class="recent-artist">${esc(s.artist)}</div></div>
    </div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:10px">Nothing played yet!</div>';
  document.getElementById('recentOverlay').classList.add('open');
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function closeModalOutside(e, id) { if (e.target === document.getElementById(id)) closeModal(id); }

// ═══════════════════════════════════════════════════════════
//  SIDEBAR MOBILE
// ═══════════════════════════════════════════════════════════
function toggleSidebar() {
  const open = document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('hamburger').classList.toggle('open', open);
  document.getElementById('sidebarOverlay').classList.toggle('open', open);
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('hamburger').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════
//  KEYBOARD
// ═══════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const map = {
    'Space': () => { e.preventDefault(); togglePlay(); },
    'ArrowRight': () => { e.preventDefault(); nextSong(); },
    'ArrowLeft':  () => { e.preventDefault(); prevSong(); },
    'KeyS': () => { state.shuffle = !state.shuffle; renderControls(); },
    'KeyR': () => document.getElementById('repeatBtn').click(),
    'ArrowUp':   () => { e.preventDefault(); audio.volume = Math.min(1, audio.volume + 0.05); document.getElementById('volumeBar').value = audio.volume * 100; },
    'ArrowDown': () => { e.preventDefault(); audio.volume = Math.max(0, audio.volume - 0.05); document.getElementById('volumeBar').value = audio.volume * 100; },
  };
  if (map[e.code]) map[e.code]();
});

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
loadSongsFromStorage();
wireInputs();
renderAll();

// Restore last song highlight
const lastId = localStorage.getItem('wave_lastSong');
if (lastId) {
  const i = songStore.findIndex(s => s.id == lastId);
  if (i !== -1) { state.idx = i; renderAll(); }
}









// ===== PWA SETUP (Install + Service Worker) =====

// Register Service Worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("service-worker.js")
      .then((reg) => console.log("Service Worker registered:", reg.scope))
      .catch((err) => console.log("Service Worker failed:", err));
  });
}

// Install App Prompt
let deferredPrompt;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;

  // Create install button dynamically
  let installBtn = document.createElement("button");
  installBtn.innerText = "Install App";
  installBtn.style.position = "fixed";
  installBtn.style.bottom = "20px";
  installBtn.style.right = "20px";
  installBtn.style.padding = "10px 15px";
  installBtn.style.background = "#000";
  installBtn.style.color = "#fff";
  installBtn.style.border = "none";
  installBtn.style.borderRadius = "8px";
  installBtn.style.cursor = "pointer";
  installBtn.style.zIndex = "9999";

  document.body.appendChild(installBtn);

