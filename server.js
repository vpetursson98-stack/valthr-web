const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

const GITHUB_OWNER = 'vpetursson98-stack';
const GITHUB_REPO = 'valthr-web';
const GITHUB_BRANCH = 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// --- Basic auth for the admin area only ---
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (ADMIN_USER && ADMIN_PASS && user === ADMIN_USER && pass === ADMIN_PASS) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="VALTHR Admin"');
  res.status(401).send('Auðkenning þörf.');
}

// --- GitHub Contents API helpers ---
const GH_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

async function ghGetFile(filePath) {
  const res = await fetch(`${GH_API}/${filePath}?ref=${GITHUB_BRANCH}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`GitHub GET ${filePath} failed: ${res.status}`);
  const data = await res.json();
  return { sha: data.sha, content: Buffer.from(data.content, 'base64') };
}

async function ghPutFile(filePath, contentBuffer, message, sha) {
  const body = {
    message,
    content: contentBuffer.toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub PUT ${filePath} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghDeleteFile(filePath, message, sha) {
  const res = await fetch(`${GH_API}/${filePath}`, {
    method: 'DELETE',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, sha, branch: GITHUB_BRANCH })
  });
  if (!res.ok) throw new Error(`GitHub DELETE ${filePath} failed: ${res.status} ${await res.text()}`);
}

function nextFilename() {
  const dir = path.join(__dirname, 'assets', 'portfolio');
  const nums = fs.readdirSync(dir)
    .map(f => parseInt(f, 10))
    .filter(n => !Number.isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return String(next).padStart(2, '0') + '.jpg';
}

// --- Admin page ---
// The HTML lives in ADMIN_HTML (see bottom of file), a plain JS string, never
// a file under the static root — so there is no path anyone could request
// (e.g. /admin/index.html or /admin-page.html) that would serve it without
// going through the requireAuth middleware below.
app.get(['/admin', '/admin/'], requireAuth, (req, res) => {
  res.type('html').send(ADMIN_HTML);
});

app.get('/admin/api/photos', requireAuth, (req, res) => {
  const photos = JSON.parse(fs.readFileSync(path.join(__dirname, 'photos.json'), 'utf8'));
  res.json(photos);
});

app.post('/admin/api/upload', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN er ekki stillt á þjóninum.' });
    if (!req.file) return res.status(400).json({ error: 'Engin mynd fannst í beiðninni.' });

    const resized = await sharp(req.file.buffer)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .rotate()
      .jpeg({ quality: 80 })
      .toBuffer();
    const meta = await sharp(resized).metadata();

    const filename = nextFilename();
    const repoPath = `assets/portfolio/${filename}`;

    await ghPutFile(repoPath, resized, `Bæta við mynd ${filename} (admin)`);

    const { sha: photosSha, content: photosContent } = await ghGetFile('photos.json');
    const photos = JSON.parse(photosContent.toString('utf8'));
    photos.unshift({ src: repoPath, w: meta.width, h: meta.height });
    await ghPutFile('photos.json', Buffer.from(JSON.stringify(photos, null, 2) + '\n'), `Bæta ${filename} í photos.json (admin)`, photosSha);

    res.json({ ok: true, src: repoPath, note: 'Vistað í GitHub — Railway endurbyggir síðuna á næstu 30-60 sekúndum.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Eitthvað fór úrskeiðis við að hlaða upp myndinni.' });
  }
});

app.post('/admin/api/delete', requireAuth, express.json(), async (req, res) => {
  try {
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN er ekki stillt á þjóninum.' });
    const { src } = req.body;
    if (!src) return res.status(400).json({ error: 'Vantar slóð myndar.' });

    const { sha: photosSha, content: photosContent } = await ghGetFile('photos.json');
    const photos = JSON.parse(photosContent.toString('utf8'));
    const remaining = photos.filter(p => p.src !== src);
    if (remaining.length === photos.length) return res.status(404).json({ error: 'Myndin fannst ekki í listanum.' });
    await ghPutFile('photos.json', Buffer.from(JSON.stringify(remaining, null, 2) + '\n'), `Fjarlægja ${src} úr photos.json (admin)`, photosSha);

    try {
      const { sha: fileSha } = await ghGetFile(src);
      await ghDeleteFile(src, `Eyða ${src} (admin)`, fileSha);
    } catch (e) {
      console.warn('Skráin fannst ekki til að eyða (var kannski þegar farin):', e.message);
    }

    res.json({ ok: true, note: 'Fjarlægt úr GitHub — Railway endurbyggir síðuna á næstu 30-60 sekúndum.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Eitthvað fór úrskeiðis við að eyða myndinni.' });
  }
});

// --- Static site ---
app.use(express.static(__dirname, { extensions: ['html'] }));

// --- Custom 404 ---
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="is">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>VALTHR — Stjórnborð</title>
<style>
  :root{--black:#0a0a0a;--white:#f5f5f5;--grey:#8a8a8a;--grey-line:#262626;}
  *{box-sizing:border-box;}
  body{background:var(--black);color:var(--white);font-family:-apple-system,Inter,sans-serif;margin:0;padding:32px 24px 80px;}
  h1{font-size:28px;margin:0 0 8px;}
  p.sub{color:var(--grey);margin:0 0 32px;font-size:14px;}
  .panel{border:1px solid var(--grey-line);padding:20px;margin-bottom:32px;max-width:480px;}
  .panel h2{font-size:16px;margin:0 0 14px;}
  input[type=file]{color:var(--white);margin-bottom:14px;display:block;}
  button{background:var(--white);color:var(--black);border:none;padding:10px 20px;font-size:14px;cursor:pointer;}
  button:hover{opacity:0.85;}
  button:disabled{opacity:0.4;cursor:default;}
  #msg{margin-top:12px;font-size:13px;color:var(--grey);min-height:18px;}
  #msg.error{color:#e05252;}
  #msg.ok{color:#8fd19e;}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px;max-width:960px;}
  .card{border:1px solid var(--grey-line);position:relative;}
  .card img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;}
  .card .path{font-size:11px;color:var(--grey);padding:6px 8px;word-break:break-all;}
  .card button{position:absolute;top:6px;right:6px;background:rgba(10,10,10,0.8);color:var(--white);border:1px solid var(--white);padding:4px 8px;font-size:11px;}
  .card button:hover{background:#e05252;border-color:#e05252;}
</style>
</head>
<body>
  <h1>VALTHR — Stjórnborð</h1>
  <p class="sub">Bættu við eða fjarlægðu myndir úr myndasafninu. Breytingar fara beint í GitHub og Railway endurbyggir síðuna sjálfkrafa á 30–60 sekúndum.</p>

  <div class="panel">
    <h2>Bæta við mynd</h2>
    <input type="file" id="fileInput" accept="image/*">
    <button id="uploadBtn">Hlaða upp</button>
    <div id="msg"></div>
  </div>

  <div id="grid"></div>

<script>
  var msgEl = document.getElementById('msg');
  var gridEl = document.getElementById('grid');

  function setMsg(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = kind || '';
  }

  function loadPhotos() {
    fetch('/admin/api/photos').then(function (r) { return r.json(); }).then(function (photos) {
      gridEl.innerHTML = '';
      photos.forEach(function (photo) {
        var card = document.createElement('div');
        card.className = 'card';

        var img = document.createElement('img');
        img.src = '/' + photo.src;
        card.appendChild(img);

        var pathEl = document.createElement('div');
        pathEl.className = 'path';
        pathEl.textContent = photo.src;
        card.appendChild(pathEl);

        var delBtn = document.createElement('button');
        delBtn.textContent = 'Eyða';
        delBtn.addEventListener('click', function () { deletePhoto(photo.src); });
        card.appendChild(delBtn);

        gridEl.appendChild(card);
      });
    });
  }

  function deletePhoto(src) {
    if (!confirm('Eyða ' + src + '?')) return;
    setMsg('Eyði...', '');
    fetch('/admin/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: src })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) { setMsg(data.error, 'error'); return; }
      setMsg(data.note || 'Fjarlægt.', 'ok');
      loadPhotos();
    }).catch(function () { setMsg('Eitthvað fór úrskeiðis.', 'error'); });
  }

  document.getElementById('uploadBtn').addEventListener('click', function () {
    var input = document.getElementById('fileInput');
    if (!input.files[0]) { setMsg('Veldu mynd fyrst.', 'error'); return; }
    var fd = new FormData();
    fd.append('photo', input.files[0]);
    var btn = this;
    btn.disabled = true;
    setMsg('Hleð upp og sendi í GitHub...', '');
    fetch('/admin/api/upload', { method: 'POST', body: fd }).then(function (r) { return r.json(); }).then(function (data) {
      btn.disabled = false;
      if (data.error) { setMsg(data.error, 'error'); return; }
      setMsg(data.note || 'Tókst!', 'ok');
      input.value = '';
      loadPhotos();
    }).catch(function () { btn.disabled = false; setMsg('Eitthvað fór úrskeiðis.', 'error'); });
  });

  loadPhotos();
</script>
</body>
</html>`;

app.listen(PORT, () => console.log(`VALTHR server running on port ${PORT}`));
