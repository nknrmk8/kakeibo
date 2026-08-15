/* =========================================================================
   ふたり家計簿 — アプリ本体
   データは localStorage、レシート画像は IndexedDB に保存します。
   ========================================================================= */
'use strict';

const LS_KEY = 'futari-kakeibo-v1';
const THEME_KEY = 'futari-kakeibo-theme';   // ロック中でも表示テーマを決められるよう別枠で持つ

/* =========================================================================
   パスコードロック（PBKDF2-SHA256 → AES-GCM で端末内のデータを暗号化）
   鍵はメモリの中だけに置き、保存も送信もしない。
   ========================================================================= */
const PBKDF2_ITER = 600000;   // OWASP推奨（2023）。古いデータは記録時の回数で復号する
let cryptoKey = null;    // 解除中のみ保持
let lockMeta = null;     // { salt(base64), iter }
let isLocked = false;

const cryptoOK = () => !!(window.crypto && window.crypto.subtle && window.isSecureContext);
const TE = new TextEncoder(), TD = new TextDecoder();

function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(s) {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', TE.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptStr(str, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, TE.encode(str));
  return { __enc: 1, iv: bufToB64(iv), ct: bufToB64(ct) };
}
async function decryptStr(rec, key) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(rec.iv) }, key, b64ToBuf(rec.ct));
  return TD.decode(pt);
}
const isEncRecord = o => !!(o && o.__enc === 1);
function readRaw() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
}

/* ---------------------------------------------------------------- 便利関数 */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const pad2 = n => String(n).padStart(2, '0');
const toDateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDateStr = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => toDateStr(new Date());
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const num = n => Math.round(n).toLocaleString('ja-JP');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const MAX_AMOUNT_DIGITS = 7;

function niceCeil(v) {
  if (!(v > 0)) return 1000;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return s * p;
}
const axisLabel = v => v >= 10000 ? (Math.round(v / 1000) / 10) + '万' : num(v);

/* ---------------------------------------------------------------- 既定データ */
function defaultDB() {
  return {
    version: 1,
    members: [{ id: 'h', name: '夫' }, { id: 'w', name: '妻' }],
    categories: {
      expense: [
        { name: '食費', icon: '🍚', budget: 0 },
        { name: '外食', icon: '🍽️', budget: 0 },
        { name: '日用品', icon: '🧴', budget: 0 },
        { name: '住居', icon: '🏠', budget: 0 },
        { name: '水道光熱', icon: '💡', budget: 0 },
        { name: '通信', icon: '📱', budget: 0 },
        { name: '交通', icon: '🚃', budget: 0 },
        { name: '医療', icon: '💊', budget: 0 },
        { name: '保険', icon: '🛡️', budget: 0 },
        { name: '教育', icon: '📚', budget: 0 },
        { name: 'こども', icon: '🧸', budget: 0 },
        { name: '趣味・娯楽', icon: '🎮', budget: 0 },
        { name: '衣服', icon: '👕', budget: 0 },
        { name: '美容', icon: '💇', budget: 0 },
        { name: '交際', icon: '🎁', budget: 0 },
        { name: '特別費', icon: '🎫', budget: 0 },
        { name: '税・社会保険', icon: '🏛️', budget: 0 },
        { name: 'その他', icon: '📦', budget: 0 }
      ],
      income: [
        { name: '給与', icon: '💼', budget: 0 },
        { name: '賞与', icon: '🎉', budget: 0 },
        { name: '副収入', icon: '💰', budget: 0 },
        { name: '臨時収入', icon: '✨', budget: 0 },
        { name: 'その他収入', icon: '📥', budget: 0 }
      ]
    },
    methods: ['現金', 'クレジット', '電子マネー', '口座振替', 'その他'],
    settings: {
      ratioH: 50, startDay: 1, saveImage: true, theme: 'auto',
      defaultPayer: 'h', keepStore: false, autoLockMin: 5
    },
    settlements: {},
    tx: []
  };
}

/* 店名・品名からカテゴリを推測するための内蔵辞書 */
const KEYWORD_CATEGORY = [
  ['食費', ['スーパー', 'マート', 'ストア', 'まいばす', 'イオン', 'ライフ', 'サミット', 'オーケー', '業務', '青果', '精肉', '鮮魚', 'セブン', 'ローソン', 'ファミマ', 'ファミリーマート', 'ミニストップ', 'デイリー', 'パン', '米', '八百屋']],
  ['外食', ['レストラン', 'カフェ', '喫茶', '珈琲', 'コーヒー', 'スタバ', 'ドトール', 'タリーズ', 'マクド', 'ラーメン', '食堂', '居酒屋', '寿司', 'そば', 'うどん', '焼肉', 'ランチ', 'ディナー', 'モス', 'ケンタッキー', 'サイゼ', 'ガスト']],
  ['日用品', ['ドラッグ', '薬局', 'マツモト', 'ウエルシア', 'サンドラッグ', 'ツルハ', 'ココカラ', 'ホームセンター', 'カインズ', 'コーナン', 'ニトリ', '無印', 'ダイソー', 'セリア', 'キャンドゥ', '洗剤', 'ティッシュ']],
  ['交通', ['JR', 'ＪＲ', 'メトロ', '地下鉄', '電車', 'バス', 'タクシー', '新幹線', 'ガソリン', 'ENEOS', '出光', 'コスモ', '駐車', 'パーキング', 'ETC', 'IC', 'Suica', 'PASMO']],
  ['医療', ['クリニック', '病院', '医院', '歯科', '調剤', '薬剤', '整骨', '接骨', '眼科', '皮膚科']],
  ['通信', ['docomo', 'ドコモ', 'au', 'ソフトバンク', 'ｿﾌﾄﾊﾞﾝｸ', '楽天モバイル', 'ワイモバイル', 'UQ', 'NTT', 'ネット', 'wifi', 'Wi-Fi']],
  ['水道光熱', ['電力', '電気', 'ガス', '水道', 'エネルギー']],
  ['趣味・娯楽', ['映画', 'シネマ', '書店', '本屋', 'ブック', 'TSUTAYA', 'ゲーム', 'カラオケ', '動物園', '水族館', 'Netflix', 'Spotify']],
  ['衣服', ['ユニクロ', 'GU', 'しまむら', '洋服', 'アパレル', '靴', 'ABCマート']],
  ['美容', ['美容', 'サロン', 'ヘア', 'カット', '理容', 'コスメ']],
  ['こども', ['保育', '幼稚園', '学童', 'こども', '子供', 'おむつ', 'ベビー', '西松屋', 'アカチャン']],
  ['教育', ['塾', '学校', '教材', '受講', 'スクール', '習い事']]
];

/* ---------------------------------------------------------------- 保存と読込 */
function normalizeDB(d) {
  try {
    if (!d) return defaultDB();
    const base = defaultDB();
    d.members ||= base.members;
    d.categories ||= base.categories;
    d.categories.expense ||= base.categories.expense;
    d.categories.income ||= base.categories.income;
    d.methods ||= base.methods;
    d.settings = Object.assign(base.settings, d.settings || {});
    d.settlements ||= {};
    d.tx ||= [];
    return d;
  } catch (e) {
    console.error('データの読み込みに失敗しました', e);
    return defaultDB();
  }
}
/* 起動時：暗号化されていれば中身は読まず、既定値で待機する */
function loadDB() {
  const raw = readRaw();
  if (isEncRecord(raw)) return defaultDB();
  return normalizeDB(raw);
}

let saveTimer = null;
let writeChain = Promise.resolve();
function saveDB(immediate) {
  clearTimeout(saveTimer);
  const queue = () => { writeChain = writeChain.then(writeNow).catch(e => console.error(e)); };
  if (immediate) queue(); else saveTimer = setTimeout(queue, 250);
}
async function writeNow() {
  if (isLocked) return;   // ロック中は書き戻さない（空データで上書きしないため）
  try {
    let payload;
    if (cryptoKey && lockMeta) {
      const rec = await encryptStr(JSON.stringify(DB), cryptoKey);
      payload = JSON.stringify({ ...rec, v: 1, iter: lockMeta.iter, salt: lockMeta.salt });
    } else {
      payload = JSON.stringify(DB);
    }
    localStorage.setItem(LS_KEY, payload);
    localStorage.setItem(THEME_KEY, (DB.settings && DB.settings.theme) || 'auto');
  } catch (e) {
    toast('保存できませんでした。端末の空き容量をご確認ください。');
    console.error(e);
  }
}

/* ---------------------------------------------------------------- 画像用IndexedDB */
const IDB = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const req = indexedDB.open('futari-kakeibo-img', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('img'); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return this._p;
  },
  async _tx(mode) { const db = await this.open(); return db.transaction('img', mode).objectStore('img'); },
  async putRaw(id, val) { const st = await this._tx('readwrite'); st.put(val, id); },
  async getRaw(id) {
    const st = await this._tx('readonly');
    return new Promise(res => { const r = st.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  },
  async entries() {
    const st = await this._tx('readonly');
    return new Promise(res => {
      const out = [];
      const r = st.openCursor();
      r.onsuccess = e => { const c = e.target.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
      r.onerror = () => res([]);
    });
  },
  /* パスコードが有効なあいだは、レシート写真も同じ鍵で暗号化して保存する */
  async put(id, dataURL) {
    const val = cryptoKey ? await encryptStr(dataURL, cryptoKey) : dataURL;
    return this.putRaw(id, val);
  },
  async get(id) {
    const v = await this.getRaw(id);
    if (!v) return null;
    if (isEncRecord(v)) {
      if (!cryptoKey) return null;
      try { return await decryptStr(v, cryptoKey); } catch (e) { return null; }
    }
    return v;
  },
  async del(id) { const st = await this._tx('readwrite'); st.delete(id); },
  async clear() { const st = await this._tx('readwrite'); st.clear(); },
  async count() {
    const st = await this._tx('readonly');
    return new Promise(res => { const r = st.count(); r.onsuccess = () => res(r.result); r.onerror = () => res(0); });
  }
};

/* ---------------------------------------------------------------- 状態 */
let DB = loadDB();
const now = new Date();
const view = {
  tab: 'home',
  mode: 'simple',
  y: now.getFullYear(),
  m: now.getMonth() + 1,
  catScope: 'all',
  catEditType: 'expense',
  catExpanded: false
};
const form = {
  type: 'expense',
  payer: DB.settings.defaultPayer || 'h',
  share: 'shared',
  method: DB.methods[0] || '現金',
  category: (DB.categories.expense[0] || {}).name || '食費',
  date: todayStr(),
  receipt: null
};
let amountDigits = '';
/* まとめて貼付で、行に書かれていなかったときに使う既定値 */
const bulkDefault = { payer: 'h', share: 'shared' };

const memberName = id => (DB.members.find(m => m.id === id) || {}).name || (id === 'h' ? '夫' : '妻');
const memberColor = id => id === 'h' ? 'var(--series-1)' : 'var(--series-2)';
const catsOf = type => DB.categories[type] || [];
const catIcon = (type, name) => (catsOf(type).find(c => c.name === name) || {}).icon || '📦';

/* ---------------------------------------------------------------- 期間 */
function periodOf(y, m) {
  const sd = Math.min(28, Math.max(1, DB.settings.startDay || 1));
  if (sd === 1) {
    return { from: toDateStr(new Date(y, m - 1, 1)), to: toDateStr(new Date(y, m, 0)) };
  }
  return { from: toDateStr(new Date(y, m - 2, sd)), to: toDateStr(new Date(y, m - 1, sd - 1)) };
}
function txInPeriod(y, m, list) {
  const { from, to } = periodOf(y, m);
  return (list || DB.tx).filter(t => t.date >= from && t.date <= to);
}
function shiftMonth(y, m, d) {
  const dt = new Date(y, m - 1 + d, 1);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1 };
}
const periodKey = (y, m) => `${y}-${pad2(m)}`;

/* ---------------------------------------------------------------- トースト */
let toastTimer = null;
function toast(msg, actionLabel, onAction) {
  const el = $('#toast');
  $('#toast-msg').textContent = msg;
  const act = $('#toast-action');
  act.classList.toggle('hidden', !actionLabel);
  if (actionLabel) {
    act.textContent = actionLabel;
    act.onclick = () => { el.classList.add('hidden'); onAction && onAction(); };
  } else {
    act.onclick = null;
  }
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), actionLabel ? 6000 : 2600);
}

/* ---------------------------------------------------------------- ツールチップ */
const tipEl = () => $('#tooltip');
function showTip(html, ev) {
  const el = tipEl();
  el.innerHTML = html;
  el.classList.remove('hidden');
  moveTip(ev);
}
function moveTip(ev) {
  const el = tipEl();
  const x = (ev.clientX || 0), y = (ev.clientY || 0);
  const r = el.getBoundingClientRect();
  let left = x + 12, top = y - r.height - 12;
  if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
  if (top < 8) top = y + 18;
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = top + 'px';
}
function hideTip() { tipEl().classList.add('hidden'); }
function bindTips(root) {
  $$('[data-tip]', root).forEach(el => {
    el.addEventListener('mouseenter', e => showTip(el.dataset.tip, e));
    el.addEventListener('mousemove', moveTip);
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('touchstart', e => showTip(el.dataset.tip, e.touches[0]), { passive: true });
  });
}
document.addEventListener('touchend', () => setTimeout(hideTip, 1800), { passive: true });

/* =========================================================================
   ヘッダ
   ========================================================================= */
function renderHeader() {
  $('#month-title').textContent = `${view.y}年${view.m}月`;
  const { from, to } = periodOf(view.y, view.m);
  const sub = $('#month-range');
  if ((DB.settings.startDay || 1) === 1) {
    sub.textContent = '';
  } else {
    const f = parseDateStr(from), t = parseDateStr(to);
    sub.textContent = `${f.getMonth() + 1}/${f.getDate()} 〜 ${t.getMonth() + 1}/${t.getDate()}`;
  }
  $('#month-nav').classList.toggle('hidden', view.tab === 'settings' || view.tab === 'add');
}

/* =========================================================================
   ホーム
   ========================================================================= */
function renderHome() {
  const tx = txInPeriod(view.y, view.m);
  const exp = tx.filter(t => t.type === 'expense');
  const inc = tx.filter(t => t.type === 'income');
  const totalExp = exp.reduce((s, t) => s + t.amount, 0);
  const totalInc = inc.reduce((s, t) => s + t.amount, 0);

  $('#sum-expense').textContent = yen(totalExp);
  $('#sum-income').textContent = yen(totalInc);

  const prev = shiftMonth(view.y, view.m, -1);
  const prevExp = txInPeriod(prev.y, prev.m).filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const dEl = $('#sum-expense-delta');
  if (prevExp > 0) {
    const d = totalExp - prevExp;
    const p = Math.round(d / prevExp * 100);
    dEl.textContent = d === 0 ? '前月と同じ' : `前月比 ${d > 0 ? '+' : '−'}${yen(Math.abs(d))}（${d > 0 ? '+' : '−'}${Math.abs(p)}%）`;
    dEl.className = 'tile-delta ' + (d > 0 ? 'up' : 'down');
  } else {
    dEl.textContent = '前月の記録なし';
    dEl.className = 'tile-delta';
  }
  const bal = totalInc - totalExp;
  const bEl = $('#sum-balance');
  bEl.textContent = totalInc > 0 ? `収支 ${bal >= 0 ? '+' : '−'}${yen(Math.abs(bal))}` : '';
  bEl.className = 'tile-delta ' + (totalInc > 0 ? (bal >= 0 ? 'down' : 'up') : '');

  renderPayerBars(exp, totalExp);
  renderSettlement(exp);
  renderCategoryChart(exp);
  renderBudgets(exp);
  renderTrend();
  renderRecent(tx);
}

/* ---------------------------------------------------------------- 支払者バー */
function renderPayerBars(exp, total) {
  const box = $('#payer-bars');
  $('#payer-count').textContent = exp.length ? `${exp.length}件` : '';
  if (!exp.length) {
    box.innerHTML = '<p class="empty">この月の支出はまだありません。</p>';
    $('#payer-legend').innerHTML = '';
    return;
  }
  const max = Math.max(...DB.members.map(mb => exp.filter(t => t.payer === mb.id).reduce((s, t) => s + t.amount, 0)), 1);
  box.innerHTML = DB.members.map(mb => {
    const v = exp.filter(t => t.payer === mb.id).reduce((s, t) => s + t.amount, 0);
    const pct = total ? Math.round(v / total * 100) : 0;
    const tip = `${esc(mb.name)}&lt;br&gt;&lt;b&gt;${yen(v)}&lt;/b&gt;（世帯の${pct}%）`
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return `<div class="payer-row" data-tip="${tip}">
      <span class="payer-name">${esc(mb.name)}</span>
      <div class="payer-track"><div class="payer-fill" style="width:${(v / max * 100).toFixed(1)}%;background:${memberColor(mb.id)}"></div></div>
      <span class="payer-amount">${yen(v)}</span>
    </div>`;
  }).join('');
  $('#payer-legend').innerHTML = DB.members.map(mb =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${memberColor(mb.id)}"></span>${esc(mb.name)}が支払</span>`
  ).join('');
  bindTips(box);
}

/* ---------------------------------------------------------------- 精算 */
function renderSettlement(exp) {
  const ratioH = Number(DB.settings.ratioH) || 0;
  const ratioW = 100 - ratioH;
  $('#settle-ratio-hint').textContent = `${memberName('h')} ${ratioH}% ／ ${memberName('w')} ${ratioW}%`;

  const shared = exp.filter(t => t.share === 'shared');
  const total = shared.reduce((s, t) => s + t.amount, 0);
  const paidH = shared.filter(t => t.payer === 'h').reduce((s, t) => s + t.amount, 0);
  const paidW = total - paidH;
  const dutyH = Math.round(total * ratioH / 100);
  const dutyW = total - dutyH;
  const diff = paidH - dutyH; // 正なら 妻 → 夫

  const key = periodKey(view.y, view.m);
  const done = !!(DB.settlements[key] && DB.settlements[key].done);

  let hero;
  if (total === 0) {
    hero = '<div class="settle-detail">「共同」で登録した支出がまだありません。</div>';
  } else if (Math.abs(diff) < 1) {
    hero = '<div class="settle-hero">精算は不要です</div>';
  } else {
    const fromName = diff > 0 ? memberName('w') : memberName('h');
    const toName = diff > 0 ? memberName('h') : memberName('w');
    hero = `<div class="settle-hero">${esc(fromName)} → ${esc(toName)}　<span class="amt">${yen(Math.abs(diff))}</span></div>
            <div class="settle-detail">共同で使ったお金を ${ratioH}:${ratioW} で分けると、この金額を渡せばおたがい同じ負担になります。</div>`;
  }

  $('#settle-body').innerHTML = hero + (total === 0 ? '' : `
    <div class="settle-detail"><table>
      <tr><td>共同費の合計</td><td class="num">${yen(total)}</td></tr>
      <tr><td>${esc(memberName('h'))}の立替</td><td class="num">${yen(paidH)}</td></tr>
      <tr><td>${esc(memberName('w'))}の立替</td><td class="num">${yen(paidW)}</td></tr>
      <tr><td>${esc(memberName('h'))}の負担すべき額</td><td class="num">${yen(dutyH)}</td></tr>
      <tr><td>${esc(memberName('w'))}の負担すべき額</td><td class="num">${yen(dutyW)}</td></tr>
    </table></div>
    <label class="settle-done"><input type="checkbox" id="settle-done" ${done ? 'checked' : ''}> この月は精算ずみ</label>
  `);

  const cb = $('#settle-done');
  if (cb) cb.addEventListener('change', () => {
    DB.settlements[key] = { done: cb.checked, amount: diff, at: new Date().toISOString() };
    saveDB();
    toast(cb.checked ? '精算ずみにしました' : '精算ずみを取り消しました');
  });
}

/* ---------------------------------------------------------------- カテゴリ別 */
function renderCategoryChart(expAll) {
  const exp = view.catScope === 'all' ? expAll : expAll.filter(t => t.payer === view.catScope);
  const box = $('#cat-chart');
  const total = exp.reduce((s, t) => s + t.amount, 0);
  if (!total) {
    box.innerHTML = '<p class="empty">記録がありません。</p>';
    $('#cat-table').innerHTML = '';
    return;
  }
  const map = new Map();
  exp.forEach(t => map.set(t.category, (map.get(t.category) || 0) + t.amount));
  let rows = Array.from(map, ([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v);
  if (rows.length > 12) {
    const rest = rows.slice(11).reduce((s, r) => s + r.v, 0);
    rows = rows.slice(0, 11).concat([{ name: 'その他まとめ', v: rest }]);
  }
  const max = rows[0].v;
  box.innerHTML = rows.map(r => {
    const pct = Math.round(r.v / total * 100);
    const tip = `${esc(r.name)}<br><b>${yen(r.v)}</b>（${pct}%）`;
    return `<div class="cat-row" data-tip="${tip}">
      <span class="cat-name">${esc(catIcon('expense', r.name))} ${esc(r.name)}</span>
      <div class="cat-track"><div class="cat-fill" style="width:${(r.v / max * 100).toFixed(1)}%"></div></div>
      <span class="cat-val">${yen(r.v)}<small>${pct}%</small></span>
    </div>`;
  }).join('');
  $('#cat-table').innerHTML = `<table><thead><tr><th>カテゴリ</th><th class="num">金額</th><th class="num">割合</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${yen(r.v)}</td><td class="num">${Math.round(r.v / total * 100)}%</td></tr>`).join('')
  }<tr><td><b>合計</b></td><td class="num"><b>${yen(total)}</b></td><td class="num">100%</td></tr></tbody></table>`;
  bindTips(box);
}

/* ---------------------------------------------------------------- 予算 */
function renderBudgets(exp) {
  const box = $('#budget-list');
  const withBudget = catsOf('expense').filter(c => Number(c.budget) > 0);
  if (!withBudget.length) {
    box.innerHTML = '<p class="empty">予算はまだ設定されていません。</p>';
    return;
  }
  box.innerHTML = withBudget.map(c => {
    const spent = exp.filter(t => t.category === c.name).reduce((s, t) => s + t.amount, 0);
    const b = Number(c.budget);
    const ratio = spent / b;
    const state = ratio > 1 ? 'critical' : ratio > 0.8 ? 'warning' : 'good';
    const stateText = { good: '✓ 予算内', warning: '！ 残りわずか', critical: '▲ 予算オーバー' }[state];
    const color = { good: 'var(--good)', warning: 'var(--warning)', critical: 'var(--critical)' }[state];
    const rest = b - spent;
    return `<div class="budget-row">
      <div class="budget-head">
        <span class="name">${esc(c.icon)} ${esc(c.name)}</span>
        <span class="nums">${yen(spent)} / ${yen(b)}</span>
      </div>
      <div class="budget-track"><div class="budget-fill" style="width:${Math.min(100, ratio * 100).toFixed(1)}%;background:${color}"></div></div>
      <span class="budget-state state-${state}">${stateText}・${rest >= 0 ? `あと ${yen(rest)}` : `${yen(-rest)} 超過`}</span>
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------------- 推移 */
function renderTrend() {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(view.y, view.m, -i));
  const data = months.map(p => {
    const e = txInPeriod(p.y, p.m).filter(t => t.type === 'expense');
    return {
      label: `${p.m}月`,
      h: e.filter(t => t.payer === 'h').reduce((s, t) => s + t.amount, 0),
      w: e.filter(t => t.payer === 'w').reduce((s, t) => s + t.amount, 0)
    };
  });
  const maxTotal = Math.max(...data.map(d => d.h + d.w), 0);
  const yMax = niceCeil(maxTotal);

  const W = 360, H = 210, PL = 46, PR = 8, PT = 22, PB = 26;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const step = plotW / data.length;
  const barW = Math.min(34, step * 0.55);
  const yOf = v => PT + plotH - (v / yMax) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="直近6か月の支出の推移">`;
  [0, 0.5, 1].forEach(f => {
    const v = yMax * f, y = yOf(v);
    svg += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${W - PR}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${PL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-muted)">${axisLabel(v)}</text>`;
  });
  svg += `<line x1="${PL}" y1="${PT + plotH}" x2="${W - PR}" y2="${PT + plotH}" stroke="var(--baseline)" stroke-width="1"/>`;

  data.forEach((d, i) => {
    const cx = PL + step * (i + 0.5);
    const x = cx - barW / 2;
    const total = d.h + d.w;
    const hH = (d.h / yMax) * plotH;
    const wH = (d.w / yMax) * plotH;
    const gap = (d.h > 0 && d.w > 0) ? 2 : 0;
    if (d.h > 0) {
      const y = PT + plotH - hH;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, hH).toFixed(1)}" fill="var(--series-1)" data-tip="${esc(d.label)}・${esc(memberName('h'))}<br><b>${yen(d.h)}</b>"/>`;
    }
    if (d.w > 0) {
      const h2 = Math.max(1, wH - gap);
      const y = PT + plotH - hH - gap - h2;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h2.toFixed(1)}" rx="4" fill="var(--series-2)" data-tip="${esc(d.label)}・${esc(memberName('w'))}<br><b>${yen(d.w)}</b>"/>`;
    } else if (d.h > 0) {
      const y = PT + plotH - hH;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.min(6, hH).toFixed(1)}" rx="4" fill="var(--series-1)" pointer-events="none"/>`;
    }
    if (total > 0) {
      svg += `<text x="${cx.toFixed(1)}" y="${(PT + plotH - hH - wH - 6).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="var(--text-secondary)">${axisLabel(total)}</text>`;
    }
    svg += `<text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${esc(d.label)}</text>`;
  });
  svg += '</svg>';

  const box = $('#trend-chart');
  box.innerHTML = svg;
  bindTips(box);
  $('#trend-legend').innerHTML = DB.members.map(mb =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${memberColor(mb.id)}"></span>${esc(mb.name)}</span>`
  ).join('');
  $('#trend-table').innerHTML = `<table><thead><tr><th>月</th><th class="num">${esc(memberName('h'))}</th><th class="num">${esc(memberName('w'))}</th><th class="num">合計</th></tr></thead><tbody>${
    data.map(d => `<tr><td>${esc(d.label)}</td><td class="num">${yen(d.h)}</td><td class="num">${yen(d.w)}</td><td class="num">${yen(d.h + d.w)}</td></tr>`).join('')
  }</tbody></table>`;
}

/* ---------------------------------------------------------------- 最近の記録 */
function renderRecent(tx) {
  const box = $('#recent-list');
  const list = tx.slice().sort((a, b) => b.date === a.date
    ? String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    : b.date.localeCompare(a.date)).slice(0, 6);
  if (!list.length) {
    box.innerHTML = '<p class="empty">まだ記録がありません。「＋ 入力」から登録してみてください。</p>';
    return;
  }
  box.innerHTML = list.map(t => txItemHTML(t, true)).join('');
  $$('.tx-item', box).forEach(el => el.addEventListener('click', () => openEdit(el.dataset.id)));
}

/* =========================================================================
   入力フォーム（テンキー方式）
   ========================================================================= */
function renderAmount() {
  const v = amountDigits ? parseInt(amountDigits, 10) : 0;
  $('#amount-num').textContent = v.toLocaleString('ja-JP');
  $('#amount-display').classList.toggle('zero', v === 0);
}
const amountValue = () => amountDigits ? parseInt(amountDigits, 10) : 0;
function setAmount(v) {
  amountDigits = v > 0 ? String(Math.min(v, 9999999)) : '';
  renderAmount();
}
function keyPress(k) {
  if (k === 'back') {
    amountDigits = amountDigits.slice(0, -1);
  } else if (k === 'clear') {
    amountDigits = '';
  } else if (k === '00') {
    if (amountDigits) amountDigits = (amountDigits + '00').slice(0, MAX_AMOUNT_DIGITS);
  } else {
    if (amountDigits.length >= MAX_AMOUNT_DIGITS) return;
    if (!amountDigits && k === '0') return;
    amountDigits += k;
  }
  renderAmount();
}

function renderDateChip() {
  const t = todayStr();
  const y = toDateStr(new Date(Date.now() - 864e5));
  const d = parseDateStr(form.date);
  let label;
  if (form.date === t) label = '今日';
  else if (form.date === y) label = '昨日';
  else label = `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`;
  $('#date-label').textContent = label;
  $('#in-date').value = form.date;
}

/* よく使う順にカテゴリを並べる */
function sortedCats(type) {
  const counts = new Map();
  DB.tx.slice(-400).forEach(t => {
    if (t.type !== type) return;
    counts.set(t.category, (counts.get(t.category) || 0) + 1);
  });
  return catsOf(type).slice().sort((a, b) => (counts.get(b.name) || 0) - (counts.get(a.name) || 0));
}

function renderCategoryGrid() {
  const all = catsOf(form.type);
  if (!all.some(c => c.name === form.category)) form.category = (all[0] || {}).name || '';
  const LIMIT = 8;
  let show;
  if (view.catExpanded || all.length <= LIMIT) {
    show = all;
  } else {
    show = sortedCats(form.type).slice(0, LIMIT);
    if (!show.some(c => c.name === form.category)) {
      const sel = all.find(c => c.name === form.category);
      if (sel) show = show.slice(0, LIMIT - 1).concat([sel]);
    }
  }
  $('#in-category').innerHTML = show.map(c =>
    `<button class="cat-btn ${form.category === c.name ? 'active' : ''}" data-cat="${esc(c.name)}">
       <span class="ico">${esc(c.icon)}</span><span class="nm">${esc(c.name)}</span>
     </button>`).join('');
  const tgl = $('#btn-cat-toggle');
  tgl.classList.toggle('hidden', all.length <= LIMIT);
  tgl.textContent = view.catExpanded ? 'よく使うだけ' : `すべて表示（${all.length}）`;
}

function renderAddForm() {
  $('#in-payer').innerHTML = DB.members.map(mb =>
    `<button data-payer="${mb.id}" class="${form.payer === mb.id ? 'active' : ''}">${esc(mb.name)}</button>`
  ).join('');
  $$('#tx-type button').forEach(b => b.classList.toggle('active', b.dataset.type === form.type));
  $$('#in-share button').forEach(b => b.classList.toggle('active', b.dataset.share === form.share));
  $('#in-share').classList.toggle('hidden', form.type !== 'expense');

  if (!DB.methods.includes(form.method)) form.method = DB.methods[0] || '';
  $('#in-method').innerHTML = DB.methods.map(m =>
    `<option value="${esc(m)}" ${form.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('');

  renderDateChip();
  renderCategoryGrid();
  renderAmount();

  const stores = Array.from(new Set(DB.tx.map(t => t.store).filter(Boolean))).slice(-80).reverse();
  $('#store-suggest').innerHTML = stores.map(s => `<option value="${esc(s)}"></option>`).join('');

  $('#bulk-payer').innerHTML = DB.members.map(mb =>
    `<button data-payer="${mb.id}" class="${bulkDefault.payer === mb.id ? 'active' : ''}">${esc(mb.name)}</button>`
  ).join('');
  $$('#bulk-share button').forEach(b => b.classList.toggle('active', b.dataset.share === bulkDefault.share));

  const hint = $('#keypad-hint');
  const cat = form.category ? `${catIcon(form.type, form.category)} ${form.category}` : '';
  hint.textContent = `${memberName(form.payer)}が${form.type === 'expense' ? (form.share === 'shared' ? '共同' : '個人') + 'で' : ''}支払 ・ ${cat} ・ ${$('#date-label').textContent}`;
}

function saveEntry() {
  const amount = amountValue();
  if (!(amount > 0)) { toast('金額を入力してください'); return; }
  const tx = {
    id: uid(),
    date: form.date,
    type: form.type,
    amount,
    category: form.category,
    payer: form.payer,
    share: form.type === 'expense' ? form.share : 'personal',
    method: form.method,
    store: $('#in-store').value.trim(),
    memo: $('#in-memo').value.trim(),
    hasImage: false,
    createdAt: new Date().toISOString()
  };
  if (form.receipt && DB.settings.saveImage) {
    tx.hasImage = true;
    IDB.put(tx.id, form.receipt).catch(e => console.error(e));
  }
  DB.tx.push(tx);
  saveDB(true);
  learnStore();

  setAmount(0);
  if (!DB.settings.keepStore) $('#in-store').value = '';
  $('#in-memo').value = '';
  clearReceipt();
  renderAddForm();
  renderHome();
  renderList();
  toast(`${yen(amount)} を登録しました`, '取り消す', () => undoEntry(tx.id));
}

function undoEntry(id) {
  const t = DB.tx.find(x => x.id === id);
  if (!t) return;
  if (t.hasImage) IDB.del(id).catch(() => {});
  DB.tx = DB.tx.filter(x => x.id !== id);
  saveDB(true);
  learnStore();
  setAmount(t.amount);
  form.date = t.date;
  form.category = t.category;
  form.payer = t.payer;
  form.share = t.share;
  form.method = t.method;
  $('#in-store').value = t.store || '';
  $('#in-memo').value = t.memo || '';
  renderAddForm();
  renderHome();
  renderList();
  toast('取り消しました。入力内容を戻しています。');
}

function clearReceipt() {
  form.receipt = null;
  $('#receipt-attached').classList.add('hidden');
  $('#receipt-attached-img').removeAttribute('src');
}

/* 店名 → カテゴリの学習（過去の入力から多数決） */
let storeIndex = null;
function buildStoreIndex() {
  storeIndex = new Map();
  const counter = new Map();
  DB.tx.forEach(t => {
    if (!t.store) return;
    const k = t.store.trim().toLowerCase();
    if (!counter.has(k)) counter.set(k, new Map());
    const c = counter.get(k);
    c.set(t.category, (c.get(t.category) || 0) + 1);
  });
  counter.forEach((c, k) => {
    let best = null, bestN = 0;
    c.forEach((n, cat) => { if (n > bestN) { bestN = n; best = cat; } });
    if (best) storeIndex.set(k, { cat: best, n: bestN });
  });
}
function learnStore() { storeIndex = null; }
function guessCategory(text, type) {
  if (!text) return null;
  const cats = catsOf(type || 'expense').map(c => c.name);
  if (!storeIndex) buildStoreIndex();
  const k = text.trim().toLowerCase();
  const learned = storeIndex.get(k);
  const usable = learned && cats.includes(learned.cat) ? learned : null;
  // 同じ店で2回以上そのカテゴリを選んでいれば、内蔵の辞書より過去の入力を優先する
  if (usable && usable.n >= 2) return usable.cat;
  for (const [cat, words] of KEYWORD_CATEGORY) {
    if (!cats.includes(cat)) continue;
    if (words.some(w => text.toLowerCase().includes(w.toLowerCase()))) return cat;
  }
  return usable ? usable.cat : null;
}

/* =========================================================================
   一覧
   ========================================================================= */
function txItemHTML(t, withDate) {
  const d = parseDateStr(t.date);
  return `<button class="tx-item" data-id="${t.id}">
    <span class="tx-ico">${esc(catIcon(t.type, t.category))}</span>
    <span class="tx-main">
      <span class="tx-title">${esc(t.store || t.category)}${t.memo ? ` <span style="color:var(--text-muted)">— ${esc(t.memo)}</span>` : ''}</span>
      <span class="tx-sub">
        ${withDate ? `<span>${d.getMonth() + 1}/${d.getDate()}</span>` : ''}
        <span class="badge"><span class="dot" style="background:${memberColor(t.payer)}"></span>${esc(memberName(t.payer))}</span>
        ${t.type === 'expense' && t.share === 'shared' ? '<span class="badge shared">共同</span>' : ''}
        <span>${esc(t.category)}</span><span>${esc(t.method)}</span>
        ${t.hasImage ? '<span>📷</span>' : ''}
      </span>
    </span>
    <span class="tx-amount ${t.type === 'income' ? 'income' : ''}">${t.type === 'income' ? '+' : ''}${yen(t.amount)}</span>
  </button>`;
}

function renderListFilters() {
  const p = $('#f-payer'), c = $('#f-category'), m = $('#f-method');
  const pv = p.value, cv = c.value, mv = m.value;
  p.innerHTML = '<option value="">支払者すべて</option>' + DB.members.map(mb => `<option value="${mb.id}">${esc(mb.name)}</option>`).join('');
  const allCats = Array.from(new Set([...catsOf('expense'), ...catsOf('income')].map(x => x.name)));
  c.innerHTML = '<option value="">カテゴリすべて</option>' + allCats.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  m.innerHTML = '<option value="">支払方法すべて</option>' + DB.methods.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  p.value = pv; c.value = cv; m.value = mv;
}

function filteredTx() {
  const text = $('#f-text').value.trim().toLowerCase();
  const fp = $('#f-payer').value, fc = $('#f-category').value,
        fs = $('#f-share').value, fm = $('#f-method').value;
  return txInPeriod(view.y, view.m).filter(t => {
    if (fp && t.payer !== fp) return false;
    if (fc && t.category !== fc) return false;
    if (fs && t.share !== fs) return false;
    if (fm && t.method !== fm) return false;
    if (text) {
      const hay = `${t.store} ${t.memo} ${t.category}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  }).sort((a, b) => a.date === b.date
    ? String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    : b.date.localeCompare(a.date));
}

function renderList() {
  const list = filteredTx();
  const e = list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const i = list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  $('#list-summary').textContent = `${list.length}件　支出 ${yen(e)}${i ? `　収入 ${yen(i)}` : ''}`;

  const box = $('#tx-list');
  if (!list.length) {
    box.innerHTML = '<p class="empty">この条件に合う記録はありません。</p>';
    return;
  }
  const byDay = new Map();
  list.forEach(t => { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); });

  box.innerHTML = Array.from(byDay, ([date, items]) => {
    const d = parseDateStr(date);
    const dayExp = items.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    return `<div class="day-group">
      <div class="day-head"><span>${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）</span>
        <span class="day-total">${yen(dayExp)}</span></div>
      ${items.map(t => txItemHTML(t, false)).join('')}
    </div>`;
  }).join('');

  $$('.tx-item', box).forEach(el => el.addEventListener('click', () => openEdit(el.dataset.id)));
}

/* =========================================================================
   編集ダイアログ
   ========================================================================= */
let editingId = null;
function openEdit(id) {
  const t = DB.tx.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  const cats = catsOf(t.type);
  $('#edit-body').innerHTML = `
    <div class="seg wide" id="e-type">
      <button data-type="expense" class="${t.type === 'expense' ? 'active' : ''}">支出</button>
      <button data-type="income" class="${t.type === 'income' ? 'active' : ''}">収入</button>
    </div>
    <label class="field"><span class="field-label">日付</span><input type="date" id="e-date" value="${t.date}"></label>
    <label class="field"><span class="field-label">金額</span><input type="text" id="e-amount" inputmode="numeric" value="${t.amount.toLocaleString('ja-JP')}"></label>
    <label class="field"><span class="field-label">カテゴリ</span>
      <select id="e-category">${cats.map(c => `<option value="${esc(c.name)}" ${c.name === t.category ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
      ${cats.some(c => c.name === t.category) ? '' : `<option value="${esc(t.category)}" selected>${esc(t.category)}</option>`}</select></label>
    <div class="field"><span class="field-label">支払った人</span>
      <div class="seg wide" id="e-payer">${DB.members.map(mb => `<button data-payer="${mb.id}" class="${t.payer === mb.id ? 'active' : ''}">${esc(mb.name)}</button>`).join('')}</div></div>
    <div class="field" id="e-share-field" ${t.type === 'income' ? 'hidden' : ''}><span class="field-label">負担</span>
      <div class="seg wide" id="e-share">
        <button data-share="shared" class="${t.share === 'shared' ? 'active' : ''}">共同</button>
        <button data-share="personal" class="${t.share !== 'shared' ? 'active' : ''}">個人</button>
      </div></div>
    <label class="field"><span class="field-label">支払方法</span>
      <select id="e-method">${DB.methods.map(m => `<option ${m === t.method ? 'selected' : ''}>${esc(m)}</option>`).join('')}
      ${DB.methods.includes(t.method) ? '' : `<option selected>${esc(t.method)}</option>`}</select></label>
    <label class="field"><span class="field-label">お店・内容</span><input type="text" id="e-store" value="${esc(t.store)}"></label>
    <label class="field"><span class="field-label">メモ</span><input type="text" id="e-memo" value="${esc(t.memo)}"></label>
    <div id="e-image"></div>
  `;
  const seg = (sel, key) => $$(`${sel} button`).forEach(b => b.addEventListener('click', () => {
    $$(`${sel} button`).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (key === 'type') {
      const ty = b.dataset.type;
      $('#e-share-field').hidden = ty === 'income';
      $('#e-category').innerHTML = catsOf(ty).map(c => `<option value="${esc(c.name)}">${esc(c.icon)} ${esc(c.name)}</option>`).join('');
    }
  }));
  seg('#e-type', 'type'); seg('#e-payer'); seg('#e-share');

  if (t.hasImage) {
    IDB.get(t.id).then(src => {
      if (src) $('#e-image').innerHTML = `<div class="field"><span class="field-label">レシート</span><div class="ocr-preview"><img src="${src}" alt="レシート"></div></div>`;
    });
  }
  $('#edit-modal').classList.remove('hidden');
}
function closeEdit() { $('#edit-modal').classList.add('hidden'); editingId = null; }

function saveEdit() {
  const t = DB.tx.find(x => x.id === editingId);
  if (!t) return closeEdit();
  const amount = parseInt(($('#e-amount').value || '').replace(/[^\d]/g, ''), 10);
  if (!(amount > 0)) { toast('金額を入力してください'); return; }
  t.type = $('#e-type button.active').dataset.type;
  t.date = $('#e-date').value || t.date;
  t.amount = amount;
  t.category = $('#e-category').value;
  t.payer = $('#e-payer button.active').dataset.payer;
  t.share = t.type === 'expense' ? $('#e-share button.active').dataset.share : 'personal';
  t.method = $('#e-method').value;
  t.store = $('#e-store').value.trim();
  t.memo = $('#e-memo').value.trim();
  saveDB(true);
  learnStore();
  closeEdit();
  renderHome(); renderList();
  toast('保存しました');
}
function deleteEdit() {
  const t = DB.tx.find(x => x.id === editingId);
  if (!t) return closeEdit();
  if (!confirm(`${t.date}　${t.store || t.category}　${yen(t.amount)}\nこの記録を削除しますか？`)) return;
  if (t.hasImage) IDB.del(t.id).catch(() => {});
  DB.tx = DB.tx.filter(x => x.id !== editingId);
  saveDB(true);
  learnStore();
  closeEdit();
  renderHome(); renderList();
  toast('削除しました');
}

/* =========================================================================
   レシート読取（OCR）
   ========================================================================= */
let ocrWorker = null;
let ocrParsed = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error(src));
    document.head.appendChild(s);
  });
}

function shrinkImage(file, maxSide, quality) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        res(cv.toDataURL('image/jpeg', quality));
      };
      img.onerror = rej;
      img.src = fr.result;
    };
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

async function handleReceipt(file) {
  if (!file) return;
  $('#ocr-area').classList.remove('hidden');
  $('#ocr-result').classList.add('hidden');
  const status = $('#ocr-status');
  status.innerHTML = '画像を準備しています…';

  let big, thumb;
  try {
    big = await shrinkImage(file, 1600, 0.85);
    thumb = await shrinkImage(file, 720, 0.6);
  } catch (e) {
    status.textContent = '画像を読み込めませんでした。';
    return;
  }
  $('#ocr-img').src = thumb;
  form.receipt = DB.settings.saveImage ? thumb : null;

  status.innerHTML = '文字を読み取っています…<div class="progress-track"><div class="progress-fill" id="ocr-bar"></div></div>';
  try {
    // 文字認識の一式は自分のサイト内から読み込む（外部CDNには一切つながない）
    if (!window.Tesseract) {
      await loadScript('vendor/tesseract.min.js');
    }
    if (!ocrWorker) {
      ocrWorker = await Tesseract.createWorker('jpn', 1, {
        workerPath: 'vendor/worker.min.js',
        corePath: 'vendor/',
        langPath: 'vendor/tessdata',
        gzip: true,
        logger: m => {
          const bar = $('#ocr-bar');
          if (bar && m.progress != null) bar.style.width = Math.round(m.progress * 100) + '%';
        }
      });
    }
    const { data } = await ocrWorker.recognize(big);
    showOcrResult(data.text || '');
  } catch (err) {
    console.error(err);
    status.innerHTML = '文字の読み取りができませんでした（通信環境をご確認ください）。<br>写真は入力画面に添付できます。金額は手で入力してください。';
    ocrParsed = { amounts: [], dates: [], stores: [], raw: '', sel: {} };
    $('#ocr-result').classList.remove('hidden');
    $('#ocr-amounts').innerHTML = '<span class="hint">候補なし</span>';
    $('#ocr-dates').innerHTML = '<span class="hint">候補なし</span>';
    $('#ocr-stores').innerHTML = '<span class="hint">候補なし</span>';
    $('#ocr-raw').textContent = '';
  }
}

function normalizeDigits(s) {
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
          .replace(/[，、]/g, ',')
          .replace(/[／]/g, '/')
          .replace(/[－ー―]/g, '-');
}

function parseReceiptText(text) {
  const lines = normalizeDigits(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  /* --- 金額 --- */
  const POS = ['合計', '合  計', '計', 'お買上', 'お買い上げ', '税込', '請求', 'お会計', '総額'];
  const NEG = ['小計', 'お預', 'お預り', '預り', 'おつり', 'お釣', '釣銭', 'ポイント', 'point', '残高', '割引', '値引', '外税', '内税', '消費税', '個', '点'];
  const DATE_LINE = /20\d{2}\s*[年/\-.]\s*\d{1,2}\s*[月/\-.]|\d{1,2}\s*[:：]\s*\d{2}/;
  const scored = new Map();
  lines.forEach(line => {
    if (DATE_LINE.test(line)) return; // 日付・時刻の行は金額として拾わない
    const hasPos = POS.some(k => line.includes(k));
    const hasNeg = NEG.some(k => line.toLowerCase().includes(k.toLowerCase()));
    // 桁区切りは「,」だけでなく、読み取り誤りで「.」になることもある
    const ms = line.match(/(?:￥|¥|\\)?\s?\d{1,3}(?:[.,]\d{3})+|(?:￥|¥|\\)\s?\d{2,7}|\d{2,7}\s?円|\b\d{3,7}\b/g);
    if (!ms) return;
    ms.forEach(raw => {
      const v = parseInt(raw.replace(/[^\d]/g, ''), 10);
      if (!(v >= 10 && v <= 3000000)) return;
      let sc = 0;
      if (hasPos) sc += 10;
      if (hasNeg) sc -= 8;
      if (/[￥¥\\]/.test(raw) || /円/.test(raw)) sc += 2;
      if (/,/.test(raw)) sc += 2;
      if (v % 1000 === 0 && v >= 10000 && !hasPos) sc -= 1;
      sc += Math.min(3, Math.log10(v));
      const prev = scored.get(v);
      if (prev == null || sc > prev) scored.set(v, sc);
    });
  });
  const amounts = Array.from(scored, ([v, sc]) => ({ v, sc }))
    .sort((a, b) => b.sc - a.sc || b.v - a.v).slice(0, 8).map(x => x.v);

  /* --- 日付 --- */
  const dates = [];
  const push = (y, m, d) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return;
    const s = `${y}-${pad2(m)}-${pad2(d)}`;
    if (!dates.includes(s)) dates.push(s);
  };
  const thisYear = new Date().getFullYear();
  lines.forEach(line => {
    let mm, found = false;
    const re1 = /(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/g;
    while ((mm = re1.exec(line))) { push(+mm[1], +mm[2], +mm[3]); found = true; }
    if (found) return;   // 年つきで取れた行は、同じ行の時刻を日付と誤読しないよう打ち切る
    // 「12.03」のような時刻を拾わないよう、区切りに「.」は使わない
    const re2 = /(?:^|[^\d])(\d{1,2})\s*[月/\-]\s*(\d{1,2})\s*日?(?![\d:.])/g;
    while ((mm = re2.exec(line))) {
      const m2 = +mm[1], d2 = +mm[2];
      if (m2 < 1 || m2 > 12 || d2 < 1 || d2 > 31) continue;
      let y = thisYear;
      if (new Date(y, m2 - 1, d2) > new Date(Date.now() + 30 * 864e5)) y -= 1;
      push(y, m2, d2);
    }
  });

  /* --- 店名 --- */
  // 日本語の文字のあいだに入ってしまった空白（読み取り由来）を詰める
  const tidy = s => s
    .replace(/([^\x00-\x7F])[ 　]+(?=[^\x00-\x7F])/g, '$1')
    .replace(/([^\x00-\x7F][-‐ー・])[ 　]+(?=[^\x00-\x7F])/g, '$1')
    .trim();
  const stores = lines.slice(0, 6)
    .filter(l => !DATE_LINE.test(l))
    .filter(l => !/\d{2,}\s*$/.test(l))
    .filter(l => !/^[\s\-=*_.]+$/.test(l))
    .map(tidy)
    .filter(l => l.length >= 2 && l.length <= 24)
    .filter(l => (l.replace(/[^\d]/g, '').length / l.length) < 0.35)
    .slice(0, 4);

  return { amounts, dates: dates.slice(0, 5), stores, raw: lines.join('\n') };
}

function showOcrResult(text) {
  ocrParsed = parseReceiptText(text);
  const p = ocrParsed;
  $('#ocr-status').textContent = p.amounts.length
    ? '読み取りました。正しいものをタップして選んでください。'
    : '金額を読み取れませんでした。下の文字を見ながら手入力してください。';
  $('#ocr-result').classList.remove('hidden');

  const sel = { amount: p.amounts[0] ?? null, date: p.dates[0] ?? null, store: p.stores[0] ?? null };
  ocrParsed.sel = sel;

  const draw = () => {
    $('#ocr-amounts').innerHTML = p.amounts.length
      ? p.amounts.map(v => `<button class="chip ${sel.amount === v ? 'active' : ''}" data-v="${v}">${yen(v)}</button>`).join('')
      : '<span class="hint">候補が見つかりませんでした</span>';
    $('#ocr-dates').innerHTML = (p.dates.length ? p.dates : [todayStr()])
      .map(d => `<button class="chip ${sel.date === d ? 'active' : ''}" data-v="${d}">${d.slice(5).replace('-', '/')}</button>`).join('');
    $('#ocr-stores').innerHTML = p.stores.length
      ? p.stores.map(s => `<button class="chip ${sel.store === s ? 'active' : ''}" data-v="${esc(s)}">${esc(s)}</button>`).join('')
      : '<span class="hint">候補が見つかりませんでした</span>';

    $$('#ocr-amounts .chip').forEach(b => b.addEventListener('click', () => { sel.amount = +b.dataset.v; draw(); }));
    $$('#ocr-dates .chip').forEach(b => b.addEventListener('click', () => { sel.date = b.dataset.v; draw(); }));
    $$('#ocr-stores .chip').forEach(b => b.addEventListener('click', () => { sel.store = b.dataset.v; draw(); }));
  };
  draw();
  $('#ocr-raw').textContent = p.raw;
}

function applyOcr() {
  const sel = (ocrParsed && ocrParsed.sel) || {};
  if (sel.amount) setAmount(sel.amount);
  if (sel.date) form.date = sel.date;
  if (sel.store) {
    $('#in-store').value = sel.store;
    const g = guessCategory(sel.store, 'expense');
    if (g) form.category = g;
  }
  if (form.receipt) {
    $('#receipt-attached').classList.remove('hidden');
    $('#receipt-attached-img').src = form.receipt;
    $('#entry-detail').open = true;
  }
  switchMode('simple');
  renderAddForm();
  toast('入力画面に反映しました。金額を確かめて保存してください。');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================================
   まとめて貼付
   ========================================================================= */
let bulkRows = [];

/* 桁区切りのカンマで分かれてしまったトークンを結合する（例: ["1","540"] → ["1540"]） */
function mergeThousands(tokens) {
  const out = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && /\d$/.test(prev) && /^\d{3}$/.test(t) && !/[/\-.]/.test(prev)) {
      out[out.length - 1] = prev + t;
    } else {
      out.push(t);
    }
  }
  return out;
}

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t').map(s => s.trim()).filter(Boolean);
  if (line.includes(',')) return mergeThousands(line.split(',').map(s => s.trim()).filter(Boolean));
  return line.split(/[\s　]+/).map(s => s.trim()).filter(Boolean);
}

function parseBulkLine(line) {
  const src = normalizeDigits(line).trim();
  if (!src) return null;
  let tokens = splitLine(src);
  const out = {
    date: todayStr(), amount: 0, type: 'expense', category: null,
    payer: bulkDefault.payer, share: bulkDefault.share,
    method: DB.methods[0] || '現金', store: '', memo: '', error: null
  };

  // 日付
  let dateIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let m = t.match(/^(20\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
    if (m) { out.date = `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`; dateIdx = i; break; }
    m = t.match(/^(\d{1,2})[/\-.](\d{1,2})$/) || t.match(/^(\d{1,2})月(\d{1,2})日$/);
    if (m) {
      const mo = +m[1], da = +m[2];
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        let y = new Date().getFullYear();
        if (new Date(y, mo - 1, da) > new Date(Date.now() + 30 * 864e5)) y -= 1;
        out.date = `${y}-${pad2(mo)}-${pad2(da)}`;
        dateIdx = i; break;
      }
    }
  }
  if (dateIdx >= 0) tokens.splice(dateIdx, 1);

  // 種別
  const typeIdx = tokens.findIndex(t => /^(収入|入金|給料|\+)$/.test(t));
  if (typeIdx >= 0) { out.type = 'income'; out.share = 'personal'; tokens.splice(typeIdx, 1); }

  // 支払者
  const names = DB.members.map(m => m.name);
  const payerIdx = tokens.findIndex(t => names.includes(t) || /^(夫|妻|H|W|h|w|おっと|つま)$/.test(t));
  if (payerIdx >= 0) {
    const t = tokens[payerIdx];
    const byName = DB.members.find(m => m.name === t);
    out.payer = byName ? byName.id : (/^(妻|W|w|つま)$/.test(t) ? 'w' : 'h');
    tokens.splice(payerIdx, 1);
  }

  // 負担
  const shareIdx = tokens.findIndex(t => /^(共同|共通|共|折半|個人|自分|私費)$/.test(t));
  if (shareIdx >= 0) {
    out.share = /^(個人|自分|私費)$/.test(tokens[shareIdx]) ? 'personal' : 'shared';
    tokens.splice(shareIdx, 1);
  }

  // 支払方法
  const methodIdx = tokens.findIndex(t => DB.methods.includes(t) || /^(現金|カード|クレカ|IC|Suica|PayPay|電子マネー)$/i.test(t));
  if (methodIdx >= 0) {
    const t = tokens[methodIdx];
    out.method = DB.methods.includes(t) ? t
      : /^(カード|クレカ)$/.test(t) ? (DB.methods.find(m => m.includes('クレジット')) || DB.methods[0])
      : /^(IC|Suica|PayPay|電子マネー)$/i.test(t) ? (DB.methods.find(m => m.includes('電子')) || DB.methods[0])
      : DB.methods[0];
    tokens.splice(methodIdx, 1);
  }

  // カテゴリ
  const allCats = catsOf(out.type).map(c => c.name);
  const catIdx = tokens.findIndex(t => allCats.includes(t));
  if (catIdx >= 0) { out.category = tokens[catIdx]; tokens.splice(catIdx, 1); }

  // 金額
  let amtIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!/\d/.test(t)) continue;
    if (!/^[￥¥\\]?[\d,]+円?$/.test(t)) continue;
    const v = parseInt(t.replace(/[^\d]/g, ''), 10);
    if (v > 0 && v <= 9999999) { out.amount = v; amtIdx = i; break; }
  }
  if (amtIdx >= 0) tokens.splice(amtIdx, 1);

  out.store = tokens.shift() || '';
  out.memo = tokens.join(' ');

  if (!out.category) out.category = guessCategory(out.store + ' ' + out.memo, out.type) || (catsOf(out.type)[0] || {}).name || 'その他';
  if (!(out.amount > 0)) out.error = '金額が読み取れません';
  return out;
}

function renderBulkPreview() {
  const box = $('#bulk-preview');
  if (!bulkRows.length) { box.innerHTML = ''; $('#btn-bulk-save').disabled = true; return; }
  const ok = bulkRows.filter(r => !r.error);
  box.innerHTML = `<p class="hint">${bulkRows.length}行のうち ${ok.length}件を登録できます（支出の合計 ${yen(ok.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0))}）。おかしい行は登録後に一覧から直せます。</p>
    <div class="bulk-scroll"><table class="bulk-table">
      <thead><tr><th>日付</th><th class="num">金額</th><th>カテゴリ</th><th>支払者</th><th>負担</th><th>方法</th><th>お店・メモ</th></tr></thead>
      <tbody>${bulkRows.map(r => `<tr class="${r.error ? 'bad' : ''}">
        <td>${r.date.slice(5).replace('-', '/')}</td>
        <td class="num">${r.error ? esc(r.error) : yen(r.amount)}</td>
        <td>${esc(r.category)}</td>
        <td>${esc(memberName(r.payer))}</td>
        <td>${r.type === 'income' ? '収入' : (r.share === 'shared' ? '共同' : '個人')}</td>
        <td>${esc(r.method)}</td>
        <td>${esc([r.store, r.memo].filter(Boolean).join(' / '))}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  $('#btn-bulk-save').disabled = ok.length === 0;
}

function saveBulk() {
  const ok = bulkRows.filter(r => !r.error);
  if (!ok.length) return;
  const stamp = new Date().toISOString();
  const ids = [];
  ok.forEach(r => {
    const id = uid();
    ids.push(id);
    DB.tx.push({
      id, date: r.date, type: r.type, amount: r.amount, category: r.category,
      payer: r.payer, share: r.type === 'expense' ? r.share : 'personal',
      method: r.method, store: r.store, memo: r.memo, hasImage: false, createdAt: stamp
    });
  });
  saveDB(true);
  learnStore();
  bulkRows = [];
  $('#bulk-text').value = '';
  renderBulkPreview();
  renderHome(); renderList(); renderAddForm();
  toast(`${ok.length}件を登録しました`, '取り消す', () => {
    const set = new Set(ids);
    DB.tx = DB.tx.filter(t => !set.has(t.id));
    saveDB(true); learnStore(); renderHome(); renderList();
    toast('取り消しました');
  });
}

/* =========================================================================
   CSV / JSON
   ========================================================================= */
const CSV_FIELDS = [
  ['', '使わない'], ['date', '日付'], ['amount', '金額'], ['type', '種別'],
  ['category', 'カテゴリ'], ['payer', '支払者'], ['share', '負担'],
  ['method', '支払方法'], ['store', 'お店・内容'], ['memo', 'メモ']
];

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = v => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function exportCSV() {
  const head = ['日付', '種別', '金額', 'カテゴリ', '支払者', '負担', '支払方法', 'お店・内容', 'メモ'];
  const rows = DB.tx.slice().sort((a, b) => a.date.localeCompare(b.date)).map(t => [
    t.date, t.type === 'income' ? '収入' : '支出', t.amount, t.category,
    memberName(t.payer), t.type === 'income' ? '' : (t.share === 'shared' ? '共同' : '個人'),
    t.method, t.store, t.memo
  ]);
  const csv = '﻿' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  download(`kakeibo_${todayStr()}.csv`, csv, 'text/csv;charset=utf-8');
  toast('CSVを書き出しました');
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

let csvRows = null, csvMap = [];
function openCSVModal(rows) {
  csvRows = rows;
  const header = rows[0] || [];
  const guess = h => {
    const s = String(h).toLowerCase();
    if (/日付|date|年月日|日にち/.test(s)) return 'date';
    if (/金額|amount|支出|価格|円/.test(s)) return 'amount';
    if (/種別|type|収支/.test(s)) return 'type';
    if (/カテゴリ|分類|費目|category|項目/.test(s)) return 'category';
    if (/支払者|担当|名前|payer|誰/.test(s)) return 'payer';
    if (/負担|共同|share/.test(s)) return 'share';
    if (/方法|手段|method|決済/.test(s)) return 'method';
    if (/店|内容|摘要|品名|store|shop/.test(s)) return 'store';
    if (/メモ|備考|memo|note/.test(s)) return 'memo';
    return '';
  };
  csvMap = header.map(guess);
  $('#csv-mapping').innerHTML = header.map((h, i) => `
    <label class="csv-map-item">
      <b>${esc(h) || `${i + 1}列目`}</b>
      <span class="sample">例: ${esc((rows[1] || [])[i] || '')}</span>
      <select data-col="${i}">${CSV_FIELDS.map(([v, l]) => `<option value="${v}" ${csvMap[i] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </label>`).join('');
  $$('#csv-mapping select').forEach(sel => sel.addEventListener('change', () => {
    csvMap[+sel.dataset.col] = sel.value;
    drawCSVPreview();
  }));
  $('#csv-hasheader').checked = true;
  drawCSVPreview();
  $('#csv-modal').classList.remove('hidden');
}

function csvRowToTx(cells) {
  const g = key => { const i = csvMap.indexOf(key); return i >= 0 ? String(cells[i] ?? '').trim() : ''; };
  const rawDate = g('date');
  let date = null;
  let m = rawDate.match(/(20\d{2})\D{0,2}(\d{1,2})\D{0,2}(\d{1,2})/);
  if (m) date = `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  else {
    m = rawDate.match(/^(\d{1,2})\D(\d{1,2})$/);
    if (m) date = `${new Date().getFullYear()}-${pad2(+m[1])}-${pad2(+m[2])}`;
  }
  const amount = parseInt(g('amount').replace(/[^\d\-]/g, ''), 10);
  if (!date || !(Math.abs(amount) > 0)) return null;

  const typeRaw = g('type');
  let type = /収入|入金|income|\+/.test(typeRaw) ? 'income' : 'expense';

  const payerRaw = g('payer');
  const byName = DB.members.find(mb => mb.name === payerRaw);
  const payer = byName ? byName.id : (/妻|w|wife|つま/i.test(payerRaw) ? 'w' : 'h');
  const shareRaw = g('share');
  const share = type === 'income' ? 'personal' : (/個人|自分|私費|personal/.test(shareRaw) ? 'personal' : 'shared');

  const category = g('category') || guessCategory(g('store') + ' ' + g('memo'), type) || (catsOf(type)[0] || {}).name || 'その他';
  const method = g('method') || DB.methods[0];

  return {
    id: uid(), date, type, amount: Math.abs(amount), category, payer, share, method,
    store: g('store'), memo: g('memo'), hasImage: false, createdAt: new Date().toISOString()
  };
}

function drawCSVPreview() {
  const skip = $('#csv-hasheader').checked ? 1 : 0;
  const body = csvRows.slice(skip);
  const ok = body.map(csvRowToTx).filter(Boolean);
  $('#csv-preview').innerHTML = `<p class="hint">${body.length}行のうち ${ok.length}件を取り込めます。日付と金額の列を指定すると取り込めます。</p>
    <div class="bulk-scroll"><table class="bulk-table"><thead><tr><th>日付</th><th class="num">金額</th><th>カテゴリ</th><th>支払者</th><th>負担</th><th>お店</th></tr></thead>
    <tbody>${ok.slice(0, 6).map(t => `<tr><td>${t.date}</td><td class="num">${yen(t.amount)}</td><td>${esc(t.category)}</td><td>${esc(memberName(t.payer))}</td><td>${t.type === 'income' ? '収入' : (t.share === 'shared' ? '共同' : '個人')}</td><td>${esc(t.store)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#csv-import').disabled = ok.length === 0;
}

function doCSVImport() {
  const skip = $('#csv-hasheader').checked ? 1 : 0;
  const list = csvRows.slice(skip).map(csvRowToTx).filter(Boolean);
  if (!list.length) return;
  list.forEach(t => {
    const cats = catsOf(t.type);
    if (!cats.some(c => c.name === t.category)) cats.push({ name: t.category, icon: '📦', budget: 0 });
    if (t.method && !DB.methods.includes(t.method)) DB.methods.push(t.method);
  });
  DB.tx.push(...list);
  saveDB(true);
  learnStore();
  $('#csv-modal').classList.add('hidden');
  renderAll();
  toast(`${list.length}件を取り込みました`);
}

function exportJSON() {
  download(`kakeibo_backup_${todayStr()}.json`, JSON.stringify(DB, null, 2), 'application/json');
  toast('バックアップを保存しました');
}
function importJSON(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (!d || !Array.isArray(d.tx)) throw new Error('形式が違います');
      const mode = confirm(`このバックアップには ${d.tx.length}件の記録が入っています。\n\n[OK] いまのデータを置き換える\n[キャンセル] いまのデータに追加する`);
      if (mode) {
        DB = Object.assign(defaultDB(), d);
      } else {
        const ids = new Set(DB.tx.map(t => t.id));
        d.tx.forEach(t => { if (!ids.has(t.id)) DB.tx.push(t); });
        (d.categories?.expense || []).forEach(c => { if (!DB.categories.expense.some(x => x.name === c.name)) DB.categories.expense.push(c); });
        (d.categories?.income || []).forEach(c => { if (!DB.categories.income.some(x => x.name === c.name)) DB.categories.income.push(c); });
        (d.methods || []).forEach(m => { if (!DB.methods.includes(m)) DB.methods.push(m); });
      }
      saveDB(true);
      learnStore();
      renderAll();
      toast('復元しました');
    } catch (e) {
      alert('このファイルは読み込めませんでした。\n' + e.message);
    }
  };
  fr.readAsText(file);
}

/* =========================================================================
   設定画面
   ========================================================================= */
function renderSettings() {
  $('#member-editor').innerHTML = DB.members.map(mb => `
    <div class="member-row">
      <span class="swatch" style="background:${memberColor(mb.id)}"></span>
      <input type="text" data-member="${mb.id}" value="${esc(mb.name)}" maxlength="8">
    </div>`).join('');
  $$('#member-editor input').forEach(inp => inp.addEventListener('change', () => {
    const mb = DB.members.find(m => m.id === inp.dataset.member);
    mb.name = inp.value.trim() || (mb.id === 'h' ? '夫' : '妻');
    inp.value = mb.name;
    saveDB(true); renderAll(); renderSettings();
  }));

  $('#ratio-name-h').textContent = memberName('h');
  $('#ratio-name-w').textContent = memberName('w');
  $('#ratio-h').value = DB.settings.ratioH;
  $('#ratio-w-view').textContent = 100 - DB.settings.ratioH;

  const sd = $('#set-startday');
  sd.innerHTML = Array.from({ length: 28 }, (_, i) => i + 1)
    .map(d => `<option value="${d}" ${DB.settings.startDay === d ? 'selected' : ''}>${d === 1 ? '1日（暦どおり）' : `${d}日`}</option>`).join('');

  $('#set-defpayer').innerHTML = DB.members.map(mb =>
    `<button data-payer="${mb.id}" class="${DB.settings.defaultPayer === mb.id ? 'active' : ''}">${esc(mb.name)}</button>`
  ).join('');
  $('#set-keepdetail').checked = !!DB.settings.keepStore;

  renderCategoryEditor();

  $('#method-editor').innerHTML = DB.methods.map((m, i) => `
    <div class="method-edit-row">
      <span class="cat-edit-name">${esc(m)}</span>
      <button class="btn small" data-mv="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn small danger" data-del-method="${i}">削除</button>
    </div>`).join('');
  $$('#method-editor [data-mv]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.mv;
    [DB.methods[i - 1], DB.methods[i]] = [DB.methods[i], DB.methods[i - 1]];
    saveDB(true); renderSettings(); renderAddForm();
  }));
  $$('#method-editor [data-del-method]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.delMethod;
    if (DB.methods.length <= 1) return toast('支払方法は1つ以上必要です');
    if (!confirm(`「${DB.methods[i]}」を削除しますか？（登録ずみの記録はそのまま残ります）`)) return;
    DB.methods.splice(i, 1);
    saveDB(true); renderSettings(); renderAddForm();
  }));

  renderLockCard();

  $('#set-saveimg').checked = !!DB.settings.saveImage;
  IDB.count().then(n => {
    $('#img-usage').textContent = `いま ${n} 枚のレシート写真を保存しています。`
      + (cryptoKey ? '（暗号化して保存中）' : '');
  }).catch(() => {});
}

function renderCategoryEditor() {
  const type = view.catEditType;
  $$('#cat-edit-type button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  const cats = catsOf(type);
  $('#category-editor').innerHTML = cats.map((c, i) => `
    <div class="cat-edit-row">
      <input type="text" class="cat-icon" data-i="${i}" value="${esc(c.icon)}" maxlength="2" style="width:52px;flex:none;text-align:center">
      <span class="cat-edit-name">${esc(c.name)}</span>
      ${type === 'expense' ? `<input type="number" data-budget="${i}" value="${c.budget || ''}" placeholder="予算" min="0" step="1000"><span class="budget-unit">円/月</span>` : ''}
      <button class="btn small" data-cmv="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn small danger" data-cdel="${i}">✕</button>
    </div>`).join('');

  $$('#category-editor [data-budget]').forEach(inp => inp.addEventListener('change', () => {
    cats[+inp.dataset.budget].budget = Math.max(0, parseInt(inp.value || '0', 10) || 0);
    saveDB(true); renderHome();
  }));
  $$('#category-editor .cat-icon').forEach(inp => inp.addEventListener('change', () => {
    cats[+inp.dataset.i].icon = inp.value.trim() || '📦';
    saveDB(true); renderCategoryEditor(); renderAddForm(); renderList();
  }));
  $$('#category-editor [data-cmv]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.cmv;
    [cats[i - 1], cats[i]] = [cats[i], cats[i - 1]];
    saveDB(true); renderCategoryEditor(); renderAddForm();
  }));
  $$('#category-editor [data-cdel]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.cdel;
    const used = DB.tx.filter(t => t.category === cats[i].name).length;
    if (cats.length <= 1) return toast('カテゴリは1つ以上必要です');
    if (!confirm(`「${cats[i].name}」を削除しますか？${used ? `\nこのカテゴリの記録が ${used}件ありますが、記録自体は残ります。` : ''}`)) return;
    cats.splice(i, 1);
    saveDB(true); renderCategoryEditor(); renderAddForm(); renderHome();
  }));
}

/* =========================================================================
   パスコードロックの操作
   ========================================================================= */
function showLock(message) {
  isLocked = true;
  document.body.classList.add('locked');
  $('#lock-screen').classList.remove('hidden');
  $('#lock-pin').value = '';
  const msg = $('#lock-msg');
  msg.textContent = message || 'この端末に保存した家計データは暗号化されています。';
  msg.classList.toggle('error', !!message);
}
function hideLock() {
  isLocked = false;
  document.body.classList.remove('locked');
  $('#lock-screen').classList.add('hidden');
  $('#lock-pin').value = '';
}

/* 保存ずみのレシート写真を、鍵の切り替えに合わせて入れ直す */
async function reencryptImages(fromKey, toKey) {
  const list = await IDB.entries().catch(() => []);
  for (const [id, val] of list) {
    let plain = val;
    if (isEncRecord(val)) {
      if (!fromKey) continue;
      try { plain = await decryptStr(val, fromKey); } catch (e) { continue; }
    }
    const next = toKey ? await encryptStr(plain, toKey) : plain;
    await IDB.putRaw(id, next);
  }
}

async function enableLock(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt, PBKDF2_ITER);
  const oldKey = cryptoKey;
  cryptoKey = key;
  lockMeta = { salt: bufToB64(salt), iter: PBKDF2_ITER };
  await reencryptImages(oldKey, key);
  await writeNow();
}

async function disableLock() {
  const oldKey = cryptoKey;
  cryptoKey = null;
  lockMeta = null;
  await reencryptImages(oldKey, null);
  await writeNow();
}

async function unlockWith(pin) {
  const raw = readRaw();
  if (!isEncRecord(raw)) return false;
  const key = await deriveKey(pin, b64ToBuf(raw.salt), raw.iter || PBKDF2_ITER);
  const json = await decryptStr(raw, key);   // パスコードが違えば例外になる
  DB = normalizeDB(JSON.parse(json));
  cryptoKey = key;
  lockMeta = { salt: raw.salt, iter: raw.iter || PBKDF2_ITER };
  resetFormDefaults();
  hideLock();
  learnStore();
  renderAll();
  switchTab('home');
  return true;
}

function lockNow() {
  if (!cryptoKey) return;
  const raw = readRaw();
  if (isEncRecord(raw)) lockMeta = { salt: raw.salt, iter: raw.iter || PBKDF2_ITER };
  cryptoKey = null;
  DB = defaultDB();          // 画面に残さないよう、いったん空にする
  showLock();
}

function resetFormDefaults() {
  form.type = 'expense';
  form.payer = DB.settings.defaultPayer || 'h';
  form.share = 'shared';
  form.method = DB.methods[0] || '現金';
  form.category = (DB.categories.expense[0] || {}).name || '食費';
  form.date = todayStr();
  form.receipt = null;
  bulkDefault.payer = DB.settings.defaultPayer || 'h';
  amountDigits = '';
}

/* ---- 設定画面のカード ---- */
function renderLockCard() {
  const box = $('#lock-settings');
  const state = $('#lock-state');
  if (!cryptoOK()) {
    state.textContent = '';
    box.innerHTML = `<p class="hint">この機能は暗号化のしくみ（Web Crypto）が使える環境でのみ利用できます。
      ファイルを直接開いた場合は使えません。https:// で公開したページか、http://localhost で開いてください。</p>`;
    return;
  }
  if (cryptoKey) {
    state.textContent = '有効';
    box.innerHTML = `
      <p class="hint">アプリを開くたびにパスコードの入力が必要です。保存されている家計データとレシート写真は暗号化されています。</p>
      <label class="field" style="margin-top:10px">
        <span class="field-label">自動でロックするまでの時間</span>
        <select id="lock-auto">
          <option value="0">すぐ</option>
          <option value="1">1分</option>
          <option value="5">5分</option>
          <option value="15">15分</option>
          <option value="-1">自動ロックしない</option>
        </select>
      </label>
      <p class="hint">アプリを離れてこの時間が過ぎると、次に開いたときにパスコードを聞きます。</p>
      <div class="actions">
        <button class="btn" id="btn-lock-now">今すぐロック</button>
        <button class="btn" id="btn-lock-change">パスコードを変更</button>
        <button class="btn danger" id="btn-lock-off">ロックをやめる</button>
      </div>`;
    $('#lock-auto').value = String(DB.settings.autoLockMin ?? 5);
    $('#lock-auto').addEventListener('change', () => {
      DB.settings.autoLockMin = parseInt($('#lock-auto').value, 10);
      saveDB(true);
    });
    $('#btn-lock-now').addEventListener('click', lockNow);
    $('#btn-lock-off').addEventListener('click', async () => {
      if (!confirm('ロックをやめると、家計データは暗号化されずにこの端末へ保存されます。よろしいですか？')) return;
      await disableLock();
      renderSettings();
      toast('ロックをやめました');
    });
    $('#btn-lock-change').addEventListener('click', () => renderLockForm(true));
    return;
  }
  state.textContent = '未設定';
  renderLockForm(false);
}

function renderLockForm(isChange) {
  const box = $('#lock-settings');
  box.innerHTML = `
    <p class="hint">${isChange ? '新しいパスコードを入力してください。' :
      'パスコードを設定すると、この端末に保存された家計データとレシート写真が暗号化され、開くときに入力が必要になります。'}</p>
    <div class="lock-form" style="margin-top:10px">
      <input type="password" id="pin1" inputmode="numeric" autocomplete="new-password" maxlength="16" placeholder="パスコード（4文字以上）">
      <input type="password" id="pin2" inputmode="numeric" autocomplete="new-password" maxlength="16" placeholder="もう一度入力">
      <div class="actions">
        <button class="btn primary" id="btn-lock-on">${isChange ? '変更する' : 'ロックを有効にする'}</button>
        ${isChange ? '<button class="btn" id="btn-lock-cancel">やめる</button>' : ''}
      </div>
    </div>
    <p class="lock-warn">パスコードを忘れると、このデータは元に戻せません（復旧手段はありません）。
    先に「バックアップを保存」でファイルを書き出しておくことをおすすめします。
    なお書き出したバックアップとCSVは暗号化されないので、置き場所にはご注意ください。</p>`;

  const cancel = $('#btn-lock-cancel');
  if (cancel) cancel.addEventListener('click', renderLockCard);

  $('#btn-lock-on').addEventListener('click', async () => {
    const a = $('#pin1').value, b = $('#pin2').value;
    if (a.length < 4) return toast('パスコードは4文字以上にしてください');
    if (a !== b) return toast('2つのパスコードが一致しません');
    const btn = $('#btn-lock-on');
    btn.disabled = true; btn.textContent = '設定しています…';
    try {
      await enableLock(a);
      renderSettings();
      toast(isChange ? 'パスコードを変更しました' : 'ロックを有効にしました');
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      toast('設定できませんでした');
    }
  });
}

/* =========================================================================
   タブ・全体描画
   ========================================================================= */
function switchTab(tab) {
  view.tab = tab;
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderHeader();
  if (tab === 'home') renderHome();
  if (tab === 'list') { renderListFilters(); renderList(); }
  if (tab === 'settings') renderSettings();
  if (tab === 'add') {
    form.date = form.date || todayStr();
    renderAddForm();
  }
  updateKeypadVisibility();
  window.scrollTo({ top: 0 });
}
function switchMode(mode) {
  view.mode = mode;
  $$('#add-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $$('.mode-panel').forEach(p => p.classList.toggle('active', p.id === 'mode-' + mode));
  updateKeypadVisibility();
}
function updateKeypadVisibility() {
  const show = view.tab === 'add' && view.mode === 'simple';
  $('#keypad-bar').classList.toggle('hidden', !show);
  document.body.classList.toggle('keypad-open', show);
}
function renderAll() {
  renderHeader();
  renderHome();
  renderListFilters();
  renderList();
  renderAddForm();
  if (view.tab === 'settings') renderSettings();
}

/* ---------------------------------------------------------------- テーマ */
function applyTheme() {
  // ロック中は DB を読めないので、別枠に控えた値を使う
  const t = (isLocked ? localStorage.getItem(THEME_KEY) : (DB.settings && DB.settings.theme)) || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/* =========================================================================
   イベント登録
   ========================================================================= */
function bindEvents() {
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btn-goto-list').addEventListener('click', () => switchTab('list'));

  // 月移動
  $('#btn-prev-month').addEventListener('click', () => {
    Object.assign(view, shiftMonth(view.y, view.m, -1));
    renderHeader(); renderHome(); renderList();
  });
  $('#btn-next-month').addEventListener('click', () => {
    Object.assign(view, shiftMonth(view.y, view.m, 1));
    renderHeader(); renderHome(); renderList();
  });
  $('#btn-this-month').addEventListener('click', () => {
    const d = new Date();
    view.y = d.getFullYear(); view.m = d.getMonth() + 1;
    renderHeader(); renderHome(); renderList();
  });

  // テーマ
  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = order.indexOf(DB.settings.theme || 'auto');
    DB.settings.theme = order[(cur + 1) % 3];
    applyTheme(); saveDB(true);
    toast({ auto: '端末の設定に合わせます', light: 'ライト表示', dark: 'ダーク表示' }[DB.settings.theme]);
  });

  // 入力モード
  $$('#add-mode button').forEach(b => b.addEventListener('click', () => switchMode(b.dataset.mode)));

  // テンキー
  $('#keypad').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    keyPress(b.dataset.k);
  });
  let backTimer = null;
  const backBtn = $('#keypad .key-back');
  const startHold = () => { backTimer = setTimeout(() => { keyPress('clear'); backTimer = null; }, 500); };
  const endHold = () => { clearTimeout(backTimer); };
  backBtn.addEventListener('pointerdown', startHold);
  backBtn.addEventListener('pointerup', endHold);
  backBtn.addEventListener('pointerleave', endHold);
  backBtn.addEventListener('contextmenu', e => e.preventDefault());

  // PCのキーボードでも入力できるように
  document.addEventListener('keydown', e => {
    if (view.tab !== 'add' || view.mode !== 'simple') return;
    if (!$('#edit-modal').classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) { keyPress(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { keyPress('back'); e.preventDefault(); }
    else if (e.key === 'Enter') { saveEntry(); e.preventDefault(); }
    else if (e.key === 'Escape') { keyPress('clear'); e.preventDefault(); }
  });

  // 種別・支払者・負担
  $$('#tx-type button').forEach(b => b.addEventListener('click', () => {
    form.type = b.dataset.type;
    view.catExpanded = false;
    renderAddForm();
  }));
  $('#in-payer').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    form.payer = b.dataset.payer; renderAddForm();
  });
  $$('#in-share button').forEach(b => b.addEventListener('click', () => {
    form.share = b.dataset.share; renderAddForm();
  }));
  $('#in-category').addEventListener('click', e => {
    const b = e.target.closest('.cat-btn'); if (!b) return;
    form.category = b.dataset.cat; renderAddForm();
  });
  $('#btn-cat-toggle').addEventListener('click', () => {
    view.catExpanded = !view.catExpanded;
    renderCategoryGrid();
    $('#btn-cat-toggle').textContent = view.catExpanded ? 'よく使うだけ' : `すべて表示（${catsOf(form.type).length}）`;
  });
  $('#in-method').addEventListener('change', () => {
    form.method = $('#in-method').value;
    renderAddForm();
  });

  // 日付
  const shiftDate = d => {
    const dt = parseDateStr(form.date);
    dt.setDate(dt.getDate() + d);
    form.date = toDateStr(dt);
    renderAddForm();
  };
  $('#date-prev').addEventListener('click', () => shiftDate(-1));
  $('#date-next').addEventListener('click', () => shiftDate(1));
  $('#date-label').addEventListener('click', () => {
    const inp = $('#in-date');
    inp.style.pointerEvents = 'auto';
    if (inp.showPicker) { try { inp.showPicker(); } catch (e) { inp.focus(); inp.click(); } }
    else { inp.focus(); inp.click(); }
    setTimeout(() => { inp.style.pointerEvents = 'none'; }, 400);
  });
  $('#in-date').addEventListener('change', () => {
    if ($('#in-date').value) { form.date = $('#in-date').value; renderAddForm(); }
  });

  // 保存
  $('#btn-save').addEventListener('click', saveEntry);
  $('#btn-detach-receipt').addEventListener('click', clearReceipt);

  // お店・メモを打つあいだは、端末のキーボードと重ならないようテンキーを隠す
  ['#in-store', '#in-memo'].forEach(sel => {
    $(sel).addEventListener('focus', () => {
      if (window.innerWidth < 900) $('#keypad-bar').classList.add('hidden');
    });
    $(sel).addEventListener('blur', () => setTimeout(updateKeypadVisibility, 100));
  });

  // レシート
  $('#in-receipt').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    handleReceipt(f);
  });
  $('#btn-ocr-apply').addEventListener('click', applyOcr);

  // 一括貼付の既定値
  $('#bulk-payer').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    bulkDefault.payer = b.dataset.payer;
    renderAddForm();
    if (bulkRows.length) $('#btn-bulk-parse').click();
  });
  $$('#bulk-share button').forEach(b => b.addEventListener('click', () => {
    bulkDefault.share = b.dataset.share;
    renderAddForm();
    if (bulkRows.length) $('#btn-bulk-parse').click();
  }));
  $('#btn-bulk-parse').addEventListener('click', () => {
    const lines = $('#bulk-text').value.split(/\r?\n/).filter(l => l.trim());
    bulkRows = lines.map(parseBulkLine).filter(Boolean);
    if (!bulkRows.length) toast('読み取れる行がありませんでした');
    renderBulkPreview();
  });
  $('#btn-bulk-save').addEventListener('click', saveBulk);

  // カテゴリ表示スコープ
  $$('#cat-scope button').forEach(b => b.addEventListener('click', () => {
    view.catScope = b.dataset.scope;
    $$('#cat-scope button').forEach(x => x.classList.toggle('active', x === b));
    renderCategoryChart(txInPeriod(view.y, view.m).filter(t => t.type === 'expense'));
  }));

  // 一覧フィルタ
  ['#f-text', '#f-payer', '#f-category', '#f-share', '#f-method'].forEach(sel =>
    $(sel).addEventListener('input', renderList));

  // 編集ダイアログ
  $('#edit-close').addEventListener('click', closeEdit);
  $('#edit-cancel').addEventListener('click', closeEdit);
  $('#edit-save').addEventListener('click', saveEdit);
  $('#edit-delete').addEventListener('click', deleteEdit);
  $('#edit-modal').addEventListener('click', e => { if (e.target.id === 'edit-modal') closeEdit(); });

  // 設定
  $('#ratio-h').addEventListener('change', () => {
    const v = Math.min(100, Math.max(0, parseInt($('#ratio-h').value || '50', 10) || 0));
    DB.settings.ratioH = v;
    $('#ratio-h').value = v;
    $('#ratio-w-view').textContent = 100 - v;
    saveDB(true); renderHome();
  });
  $('#set-startday').addEventListener('change', () => {
    DB.settings.startDay = parseInt($('#set-startday').value, 10) || 1;
    saveDB(true); renderAll();
  });
  $('#set-defpayer').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    DB.settings.defaultPayer = b.dataset.payer;
    form.payer = b.dataset.payer;
    saveDB(true); renderSettings(); renderAddForm();
  });
  $('#set-keepdetail').addEventListener('change', () => {
    DB.settings.keepStore = $('#set-keepdetail').checked;
    saveDB(true);
  });
  $$('#cat-edit-type button').forEach(b => b.addEventListener('click', () => {
    view.catEditType = b.dataset.type; renderCategoryEditor();
  }));
  $('#btn-add-cat').addEventListener('click', () => {
    const name = $('#new-cat-name').value.trim();
    if (!name) return;
    const cats = catsOf(view.catEditType);
    if (cats.some(c => c.name === name)) return toast('同じ名前のカテゴリがあります');
    cats.push({ name, icon: '📦', budget: 0 });
    $('#new-cat-name').value = '';
    saveDB(true); renderCategoryEditor(); renderAddForm(); renderListFilters();
  });
  $('#btn-add-method').addEventListener('click', () => {
    const name = $('#new-method-name').value.trim();
    if (!name) return;
    if (DB.methods.includes(name)) return toast('同じ支払方法があります');
    DB.methods.push(name);
    $('#new-method-name').value = '';
    saveDB(true); renderSettings(); renderAddForm(); renderListFilters();
  });
  $('#set-saveimg').addEventListener('change', () => {
    DB.settings.saveImage = $('#set-saveimg').checked;
    saveDB(true);
  });
  $('#btn-clear-images').addEventListener('click', async () => {
    if (!confirm('保存したレシート写真をすべて削除しますか？（金額などの記録は残ります）')) return;
    await IDB.clear();
    DB.tx.forEach(t => t.hasImage = false);
    saveDB(true); renderSettings(); renderList();
    toast('写真を削除しました');
  });

  // データ入出力
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#btn-export-json').addEventListener('click', exportJSON);
  $('#in-csv').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      const rows = parseCSV(fr.result);
      if (!rows.length) return alert('このCSVには読み取れる行がありませんでした。');
      openCSVModal(rows);
    };
    fr.readAsText(f, 'UTF-8');
  });
  $('#in-json').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importJSON(f);
  });
  $('#csv-close').addEventListener('click', () => $('#csv-modal').classList.add('hidden'));
  $('#csv-cancel').addEventListener('click', () => $('#csv-modal').classList.add('hidden'));
  $('#csv-hasheader').addEventListener('change', drawCSVPreview);
  $('#csv-import').addEventListener('click', doCSVImport);
  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('すべての記録・設定を消します。よろしいですか？\n（先にバックアップの保存をおすすめします）')) return;
    if (!confirm('本当に消してよいですか？この操作は取り消せません。')) return;
    await IDB.clear().catch(() => {});
    localStorage.removeItem(LS_KEY);
    DB = defaultDB();
    saveDB(true);
    renderAll(); renderSettings();
    toast('データを消しました');
  });
}

/* =========================================================================
   ロック画面の操作
   ========================================================================= */
let unlockBusy = false;
let failCount = 0;

async function tryUnlock() {
  if (unlockBusy) return;
  const pin = $('#lock-pin').value;
  if (pin.length < 4) { showLock('パスコードは4文字以上です。'); return; }
  unlockBusy = true;
  const msg = $('#lock-msg');
  msg.classList.remove('error');
  msg.textContent = '確認しています…';
  try {
    await unlockWith(pin);
    failCount = 0;
  } catch (e) {
    failCount++;
    // 総当たりを遅くするため、失敗のたびに待ち時間を延ばす
    const wait = Math.min(5000, 400 * failCount);
    await new Promise(r => setTimeout(r, wait));
    showLock(`パスコードが違います（${failCount}回目）。`);
  } finally {
    unlockBusy = false;
  }
}

function bindLockScreen() {
  $('#lock-keypad').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const inp = $('#lock-pin');
    if (b.dataset.k === 'back') inp.value = inp.value.slice(0, -1);
    else if (b.dataset.k === 'ok') tryUnlock();
    else if (inp.value.length < 16) inp.value += b.dataset.k;
  });
  $('#lock-pin').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  $('#lock-forgot').addEventListener('click', () => {
    alert('パスコードは端末にも作者にも保存されていないため、思い出す以外に開く方法はありません。\n\n'
      + 'どうしても開けない場合は、いったんデータを消して最初からやり直すことになります。\n'
      + '以前に書き出したバックアップ（JSON）があれば、そこから復元できます。');
    if (!confirm('この端末の家計データをすべて消して、最初からやり直しますか？\nこの操作は取り消せません。')) return;
    if (!confirm('本当に消してよいですか？')) return;
    localStorage.removeItem(LS_KEY);
    IDB.clear().catch(() => {}).then(() => location.reload());
  });

  // 一定時間はなれていたら自動でロックする
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (!cryptoKey || !hiddenAt) return;
    const mins = DB.settings.autoLockMin;
    if (mins < 0) return;
    if (Date.now() - hiddenAt >= mins * 60000) lockNow();
  });
}

/* =========================================================================
   起動
   ========================================================================= */
function init() {
  bindEvents();
  bindLockScreen();

  const raw = readRaw();
  if (isEncRecord(raw)) {
    lockMeta = { salt: raw.salt, iter: raw.iter || PBKDF2_ITER };
    showLock();
    applyTheme();
  } else {
    applyTheme();
    renderAll();
    switchTab('home');
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', init);
