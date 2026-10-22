/* Page chrome around the game canvas: toolbar (fullscreen / save export & import / about),
 * fun.aitobox.com platform badge + easter egg, error overlay and the orientation hint. */
(function (root) {
  'use strict';
  const ATB = root.ATB = root.ATB || {};
  const GAME_ID = 'atb_balatro';
  const SAVE_VERSION = '1.0.0';
  const PORTAL = 'https://fun.aitobox.com';

  const I18N = {
    'en': { fs: 'Fullscreen', exp: 'Export save', imp: 'Import save', about: 'About', ok: 'Save imported - game restarted', bad: 'Invalid save file - nothing was changed', saved: 'Save exported', storage: 'Browser storage is full or blocked - progress will not survive closing the tab (use Export save)', lost: 'Graphics context lost',
      egg: 'Easter Egg Discovered! This game was automatically reverse-engineered and ported by the atb-game-porting skill powered by fun.aitobox.com', rotate: 'Rotate your device for the best experience', dismiss: 'Dismiss', err: 'Something went wrong', reload: 'Reload', close: 'Close',
      note: 'Original game by LocalThunk / Playstack. Web port runs the original game logic.' },
    'zh-CN': { fs: '全屏', exp: '导出存档', imp: '导入存档', about: '关于', ok: '存档已导入，游戏已重启', bad: '存档文件无效，未做任何更改', saved: '存档已导出', storage: '浏览器存储已满或被禁用，关闭页面后进度会丢失（请使用导出存档）', lost: '图形上下文丢失',
      egg: '彩蛋被发现了！本游戏由 atb-game-porting 技能借助 fun.aitobox.com 自动逆向并移植', rotate: '横屏体验更佳', dismiss: '知道了', err: '出错了', reload: '重新加载', close: '关闭',
      note: '原作：LocalThunk / Playstack。网页版直接运行原版游戏逻辑。' },
    'ja': { fs: '全画面', exp: 'セーブを書き出す', imp: 'セーブを読み込む', about: '情報', ok: 'セーブを読み込み、ゲームを再起動しました', bad: '無効なセーブファイルです', saved: 'セーブを書き出しました', storage: 'ブラウザの保存領域がいっぱいか無効です。タブを閉じると進行状況が失われます（セーブを書き出してください）', lost: 'グラフィックスコンテキストが失われました',
      egg: 'イースターエッグ発見！このゲームは fun.aitobox.com の atb-game-porting スキルで自動的に解析・移植されました', rotate: '横向きでお楽しみください', dismiss: '閉じる', err: 'エラーが発生しました', reload: '再読み込み', close: '閉じる',
      note: '原作：LocalThunk / Playstack。' },
    'fr': { fs: 'Plein écran', exp: 'Exporter la sauvegarde', imp: 'Importer la sauvegarde', about: 'À propos', ok: 'Sauvegarde importée, jeu redémarré', bad: 'Fichier invalide, rien n’a été modifié', saved: 'Sauvegarde exportée', storage: 'Stockage du navigateur plein ou bloqué : la progression sera perdue (exportez la sauvegarde)', lost: 'Contexte graphique perdu',
      egg: 'Easter egg découvert ! Ce jeu a été rétro-conçu et porté automatiquement par la compétence atb-game-porting de fun.aitobox.com', rotate: 'Tournez l’appareil pour une meilleure expérience', dismiss: 'Fermer', err: 'Une erreur est survenue', reload: 'Recharger', close: 'Fermer',
      note: 'Jeu original par LocalThunk / Playstack.' },
    'de': { fs: 'Vollbild', exp: 'Spielstand exportieren', imp: 'Spielstand importieren', about: 'Info', ok: 'Spielstand importiert, Spiel neu gestartet', bad: 'Ungültige Datei – nichts wurde geändert', saved: 'Spielstand exportiert', storage: 'Browser-Speicher voll oder gesperrt – Fortschritt geht verloren (Spielstand exportieren)', lost: 'Grafikkontext verloren',
      egg: 'Easter Egg entdeckt! Dieses Spiel wurde automatisch mit dem atb-game-porting-Skill von fun.aitobox.com analysiert und portiert', rotate: 'Gerät drehen für das beste Erlebnis', dismiss: 'Schließen', err: 'Es ist ein Fehler aufgetreten', reload: 'Neu laden', close: 'Schließen',
      note: 'Originalspiel von LocalThunk / Playstack.' },
    'es': { fs: 'Pantalla completa', exp: 'Exportar partida', imp: 'Importar partida', about: 'Acerca de', ok: 'Partida importada, juego reiniciado', bad: 'Archivo no válido: no se cambió nada', saved: 'Partida exportada', storage: 'Almacenamiento del navegador lleno o bloqueado: se perderá el progreso (exporta la partida)', lost: 'Contexto gráfico perdido',
      egg: '¡Huevo de Pascua descubierto! Este juego fue portado automáticamente con la habilidad atb-game-porting de fun.aitobox.com', rotate: 'Gira el dispositivo para una mejor experiencia', dismiss: 'Cerrar', err: 'Algo salió mal', reload: 'Recargar', close: 'Cerrar',
      note: 'Juego original de LocalThunk / Playstack.' },
  };
  function lang() {
    const n = (navigator.language || 'en').toLowerCase();
    if (n.startsWith('zh')) return 'zh-CN';
    for (const k of ['ja', 'fr', 'de', 'es']) if (n.startsWith(k)) return k;
    return 'en';
  }
  const T = (k) => (I18N[lang()] || I18N.en)[k] || I18N.en[k];

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'text') e.textContent = v; else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else e.setAttribute(k, v); }
    for (const c of children || []) e.appendChild(c);
    return e;
  }

  function toast(msg) {
    const t = el('div', { class: 'atb-toast', text: msg });
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2600);
  }

  /* ---------------------------------------------------------------- save export / import */
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function exportSave(rt) {
    const data = {};
    if (rt.host && rt.host.fsStore) for (const [k, v] of rt.host.fsStore.map.entries()) data[k] = v;
    const env = { game_id: GAME_ID, version: SAVE_VERSION, timestamp: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(env)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: GAME_ID + '_save_' + stamp() + '.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(T('saved'));
  }

  /* Validate first, then replace the store atomically (with a backup) and soft-restart the Lua VM: no page reload. */
  function importSave(rt, text, restart) {
    let env;
    try { env = JSON.parse(text); } catch (e) { toast(T('bad')); return false; }
    if (!env || env.game_id !== GAME_ID || typeof env.data !== 'object' || env.data === null) { toast(T('bad')); return false; }
    for (const v of Object.values(env.data)) if (typeof v !== 'string') { toast(T('bad')); return false; }
    const store = rt.host.fsStore;
    const backup = new Map(store.map);
    try {
      for (const k of Array.from(store.map.keys())) store.remove(k);
      for (const [k, v] of Object.entries(env.data)) store.set(k, v);
    } catch (e) {
      for (const k of Array.from(store.map.keys())) store.remove(k);
      for (const [k, v] of backup) store.set(k, v);
      toast(T('bad')); return false;
    }
    toast(T('ok'));
    restart();
    return true;
  }

  /* ---------------------------------------------------------------- about / easter egg */
  function showAbout(egg) {
    if (document.getElementById('atb-about')) return;
    const close = () => document.getElementById('atb-about').remove();
    const m = el('div', { id: 'atb-about', class: 'atb-modal', on: { click: (e) => { if (e.target.id === 'atb-about') close(); } } }, [
      el('div', { class: 'atb-card' }, [
        el('div', { class: 'atb-title', text: egg ? '🎉 ' + T('egg').split('!')[0].split('！')[0] + (T('egg').includes('！') ? '！' : '!') : 'Balatro · Web' }),
        el('p', { text: egg ? T('egg') : T('note') }),
        el('p', {}, [el('a', { href: PORTAL, target: '_blank', rel: 'noopener noreferrer', text: '🎮 Powered by fun.aitobox.com' })]),
        el('button', { text: T('close'), on: { click: close } }),
      ]),
    ]);
    document.body.appendChild(m);
  }

  function banner() {
    console.log('%c🎮 Ported with atb-game-porting skill | Powered by fun.aitobox.com (' + PORTAL + ')',
      'background:#111827;color:#38bdf8;padding:6px 12px;border-radius:6px;font-weight:bold;');
  }

  /* ---------------------------------------------------------------- chrome */
  function buildChrome(rt, restart) {
    const file = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', on: { change: (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const r = new FileReader(); r.onload = () => importSave(rt, String(r.result), restart); r.readAsText(f); e.target.value = '';
    } } });
    let eggClicks = 0, eggTimer = null;
    const badge = el('a', { class: 'atb-badge', href: PORTAL, target: '_blank', rel: 'noopener noreferrer', text: '🎮 fun.aitobox.com', title: 'Powered by fun.aitobox.com', on: { click: (e) => {
      eggClicks++; clearTimeout(eggTimer); eggTimer = setTimeout(() => { eggClicks = 0; }, 1800);
      if (eggClicks >= 3) { e.preventDefault(); eggClicks = 0; showAbout(true); }
    } } });
    const mk = (label, title, fn) => el('button', { class: 'atb-btn', text: label, title, 'aria-label': title, on: { click: fn } });
    const tools = el('div', { class: 'atb-tools' }, [
      mk('⛶', T('fs'), () => toggleFullscreen(rt.container.parentElement || document.documentElement)),
      mk('⬇', T('exp'), () => exportSave(rt)),
      mk('⬆', T('imp'), () => file.click()),
      mk('ℹ', T('about'), () => showAbout(false)),
      badge,
    ]);
    const bar = el('div', { class: 'atb-bar' }, [
      tools,
      mk('⋯', '', () => { bar.classList.toggle('open'); }),
    ]);
    document.body.appendChild(bar); document.body.appendChild(file);
    return bar;
  }

  function toggleFullscreen(target) {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
    const fn = target.requestFullscreen || target.webkitRequestFullscreen;
    if (fn) { try { const p = fn.call(target); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
  }

  function orientationHint() {
    const h = el('div', { class: 'atb-rotate', text: '📱↻ ' + T('rotate'), on: { click: () => h.remove() } });
    document.body.appendChild(h);
    const upd = () => { h.style.display = (!h.isConnected ? 'none' : (window.innerHeight > window.innerWidth * 1.1 ? 'block' : 'none')); };
    window.addEventListener('resize', upd); upd();
  }

  function errorOverlay(e) {
    const m = el('div', { class: 'atb-modal', style: 'background:#000d' }, [
      el('div', { class: 'atb-card' }, [
        el('div', { class: 'atb-title', text: '⚠ ' + T('err') }),
        el('pre', { text: String(e && e.message || e).slice(0, 1200) }),
        el('button', { text: T('reload'), on: { click: () => location.reload() } }),
      ]),
    ]);
    document.body.appendChild(m);
  }

  ATB.ui = { buildChrome, orientationHint, errorOverlay, banner, showAbout, exportSave, importSave, toast, T };
})(typeof window !== 'undefined' ? window : globalThis);
