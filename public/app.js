const $ = (s) => document.querySelector(s);

const STATUS_AR = {
  queued: 'في الانتظار',
  uploading: 'رفع الصور',
  submitting: 'إرسال',
  running: 'قيد التوليد',
  downloading: 'تحميل',
  succeeded: 'جاهز',
  failed: 'فشل',
  cancelled: 'ملغى',
};

let providers = [];
let maxImages = 5;
const selected = new Set();
const seenDone = new Set();
let firstLoad = true;

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fillSelect(sel, values, keep) {
  const prev = keep ? sel.value : null;
  sel.replaceChildren(...values.map((v) => new Option(v, v)));
  if (prev && values.includes(prev)) sel.value = prev;
}

function currentProvider() {
  return providers.find((p) => p.id === $('#provider').value);
}

function applyProvider() {
  const p = currentProvider();
  if (!p) return;
  const c = p.capabilities;
  fillSelect($('#resolution'), c.resolutions, true);
  if (!$('#resolution').dataset.touched) $('#resolution').value = c.resolutions[0]; // cheapest by default
  fillSelect($('#aspectRatio'), c.aspectRatios, true);
  const d = $('#duration');
  d.min = c.minDuration;
  d.max = c.maxDuration;
  if (+d.value < c.minDuration) d.value = c.minDuration;
  if (+d.value > c.maxDuration) d.value = c.maxDuration;
  const cap = Math.min(maxImages, c.maxImages);
  $('#max-images').textContent = cap;
  $('#provider-info').textContent =
    `الموديل: ${p.model} · المدة ${c.minDuration}–${c.maxDuration} ث · حتى ${cap} صور` +
    (c.maxDuration < 20 ? ' · لمدة أطول: ولّد مقاطع وادمجها.' : '');
}

async function loadProviders() {
  const data = await api('/api/providers');
  providers = data.providers;
  maxImages = data.maxImages;
  const sel = $('#provider');
  sel.replaceChildren(...providers.map((p) => {
    const o = new Option(p.configured ? p.label : `${p.label} — بدون مفتاح`, p.id);
    o.disabled = !p.configured;
    return o;
  }));
  const firstReady = providers.find((p) => p.configured && p.id !== 'mock') || providers.find((p) => p.configured);
  if (firstReady) sel.value = firstReady.id;
  applyProvider();
}

async function loadUsage(withBalance = false) {
  const u = await api(`/api/usage${withBalance ? '?balance=1' : ''}`);
  const parts = [`المستخدم: <b>${u.total}</b> / ${u.limit}`, `المتبقي: <b>${u.remaining}</b>`];
  for (const [id, b] of Object.entries(u.balances || {})) {
    if (b) parts.push(`رصيد ${id}: <b>${b.amount}</b> ${b.unit}`);
  }
  $('#usage').innerHTML = parts.join(' · ') +
    ' · <button type="button" class="secondary" id="refresh-balance" style="padding:2px 8px;font-size:12px">تحديث الرصيد</button>';
  $('#refresh-balance').onclick = () => loadUsage(true);
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined));
  return n;
}

function autoDownload(job) {
  const a = el('a', { href: `/output/${encodeURIComponent(job.file)}`, download: job.file });
  document.body.append(a);
  a.click();
  a.remove();
}

function renderJobs(jobs, q) {
  $('#paused').hidden = !q.paused;
  $('#paused-reason').textContent = q.paused ? `القائمة متوقفة: ${q.pauseReason}` : '';

  const list = $('#jobs');
  if (!jobs.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'لا يوجد شي بعد.'));
    return true;
  }
  const items = [...jobs].reverse().map((j) => {
    const done = j.status === 'succeeded' && j.file;
    if (done && !seenDone.has(j.id)) {
      seenDone.add(j.id);
      if (!firstLoad) autoDownload(j);
    }
    const head = el('div', { class: 'job-head' },
      done ? el('input', {
        type: 'checkbox', checked: selected.has(j.id), 'aria-label': 'اختيار للدمج',
        onchange: (e) => { e.target.checked ? selected.add(j.id) : selected.delete(j.id); updateStitch(); },
        style: 'width:auto',
      }) : null,
      el('span', { class: `status ${j.status}` }, STATUS_AR[j.status] || j.status),
      el('span', {}, `${j.provider} · ${j.resolution} · ${j.duration}ث · ${j.aspectRatio}`),
      j.imageCount ? el('span', {}, `${j.imageCount} صور`) : null,
      j.providerStatus && j.status === 'running' ? el('span', {}, `(${j.providerStatus})`) : null,
    );
    const actions = el('div', { class: 'job-actions' },
      done ? el('a', { href: `/output/${encodeURIComponent(j.file)}`, download: j.file }, 'تحميل') : null,
      j.status === 'queued' ? el('button', { type: 'button', class: 'secondary', onclick: () => act(`/api/jobs/${j.id}`, 'DELETE') }, 'إلغاء') : null,
      ['failed', 'cancelled'].includes(j.status) ? el('button', { type: 'button', class: 'secondary', onclick: () => act(`/api/jobs/${j.id}/retry`) }, 'إعادة') : null,
    );
    return el('li', { class: 'job' },
      head,
      el('div', { class: 'job-prompt' }, j.prompt),
      j.error ? el('div', { class: 'job-err' }, j.error) : null,
      done ? el('video', { src: `/output/${encodeURIComponent(j.file)}`, controls: true, preload: 'metadata' }) : null,
      actions,
    );
  });
  // Keep playing videos from being reset on every poll.
  if ([...list.querySelectorAll('video')].some((v) => !v.paused)) return false;
  list.replaceChildren(...items);
  return true;
}

function updateStitch() {
  $('#stitch').disabled = selected.size < 2;
  $('#stitch').textContent = selected.size ? `دمج المحدد (${selected.size})` : 'دمج المحدد';
}

let lastJson = '';
async function refresh() {
  try {
    const data = await api('/api/jobs');
    const json = JSON.stringify(data);
    if (json !== lastJson) {
      lastJson = renderJobs(data.jobs, data.queue) ? json : '';
      await loadUsage();
    }
    firstLoad = false;
  } catch (e) {
    console.error(e);
  }
}

async function act(path, method = 'POST', body) {
  try {
    await api(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    alert(e.message);
  }
  refresh();
}

$('#provider').addEventListener('change', applyProvider);
$('#resolution').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });

$('#images').addEventListener('change', (e) => {
  const cap = Math.min(maxImages, currentProvider()?.capabilities.maxImages ?? maxImages);
  const files = [...e.target.files];
  $('#form-error').textContent = files.length > cap ? `الحد الأقصى ${cap} صور` : '';
  $('#previews').replaceChildren(...files.slice(0, cap).map((f, i) => el('img', { src: URL.createObjectURL(f), alt: `صورة ${i + 1}`, title: `@Image ${i + 1}` })));
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#form-error').textContent = '';
  const fd = new FormData(e.target);
  const cap = Math.min(maxImages, currentProvider()?.capabilities.maxImages ?? maxImages);
  if ($('#images').files.length > cap) {
    $('#form-error').textContent = `الحد الأقصى ${cap} صور`;
    return;
  }
  $('#submit').disabled = true;
  try {
    await api('/api/jobs', { method: 'POST', body: fd });
    refresh();
  } catch (err) {
    $('#form-error').textContent = err.message;
  } finally {
    $('#submit').disabled = false;
  }
});

$('#resume').addEventListener('click', () => act('/api/queue/resume'));
$('#clear-queued').addEventListener('click', () => act('/api/queue/clear'));
$('#clear-finished').addEventListener('click', () => { selected.clear(); updateStitch(); act('/api/jobs/clear-finished'); });
$('#stitch').addEventListener('click', async () => {
  // Stitch in the order they were created (oldest first).
  const data = await api('/api/jobs');
  const ids = data.jobs.filter((j) => selected.has(j.id)).map((j) => j.id);
  $('#stitch').disabled = true;
  $('#stitch-result').textContent = 'جاري الدمج…';
  try {
    const { file } = await api('/api/stitch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobIds: ids }) });
    $('#stitch-result').replaceChildren('تم الدمج: ', el('a', { href: `/output/${encodeURIComponent(file)}`, download: file }, file));
  } catch (err) {
    $('#stitch-result').textContent = err.message;
  } finally {
    updateStitch();
  }
});

await loadProviders();
await loadUsage(true);
await refresh();
setInterval(refresh, 2000);
