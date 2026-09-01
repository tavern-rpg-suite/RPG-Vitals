import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveChatDebounced, saveSettingsDebounced, setExtensionPrompt, extension_prompt_roles } from '../../../../script.js';

const MODULE_NAME = 'rpg_vitals';
const PROMPT_KEY = 'rpg_vitals_injection';
const PROMPT_KEY_STARVE = 'rpg_vitals_starving';
const PROMPT_KEY_COMBAT = 'rpg_vitals_combat';

const defaultSettings = {
    enabled: false,
    language: 'en',
    injectDepth: 1,
    defaultMaxHp: 100,
    hungerEnabled: false,
    hungerDrainEvery: 3,
    hungerDrainAmount: 5,
    starveDamage: 2,
    autoExpire: true,
    autoExpireMax: 20,
    levelEnabled: false,
    manaEnabled: false,
    fatigueEnabled: false,
    gmControls: false,
    angelEnabled: false,   // the death trial; off until asked for
    angelDepth: 6,         // how many recent messages the angel reads
    autoDetect: false,
    combatInject: true,
    combatDepth: 1,
    combatAuto: false,
    combatScanMsgs: 4,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'google/gemma-4-31b-it',
    temperature: 0.4,
    strictJson: true,
    chatStates: {},
    chatStamps: {}   // chatId -> last-used timestamp, lets stale states be pruned
};

let settings = {};
let state = null;
let vitalsBusy = false; // re-entrancy lock so auto-analyses can't stack/loop (prevents freezes after eating)
let _builtSig = null;   // signature of the last full panel build — lets stat updates repaint in place (no flicker)

function genId() { return Math.random().toString(36).substr(2, 9); }
function escapeHtml(x) {
    return String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const I18N = {
    en: {
        btn_title: 'HP & Effects', panel_title: 'Vitals',
        hp: 'HP', max: 'Max', heal: 'Heal', hurt: 'Damage', set_hp: 'Set',
        effects: 'Effects', add_effect: 'Add effect', name_ph: 'Effect name', effect_ph: 'What it does (optional)',
        kind: 'Kind', buff: 'Buff', debuff: 'Debuff', duration: 'Turns', no_effects: 'No active effects.',
        remove: 'Remove', save: 'Save', cancel: 'Cancel', forever: '∞',
        inject_hp: "{{user}}'s HP: {hp}/{max}", inject_effects: 'Active effects', inject_effects_note: 'Let these effects meaningfully shape the scene: each + gives {{user}} a real, fitting advantage and each − a real hindrance in relevant moments (combat, social, physical), without narrating them as on-screen game text',
        toast_restored: 'Vitals restored from the chat backup.',
        toast_added: 'Effect added.', toast_expired: '{name} wore off.',
        toast_healed: 'Healed +{n} HP.', toast_hurt: '−{n} HP.', toast_need_name: 'Enter an effect name.',
        toast_armor: 'Armor absorbed {n} damage.',
        vex_sub: 'MEDICAL EXAMINATION', exam_b: 'EXAM', exam_i: 'exam', lbl_health: 'HEALTH · HP', lbl_satiety: 'SATIETY', lbl_effects: 'EFFECTS', clean: 'CLEAN', close: 'Close',
        combat: 'Combat', add_enemy: 'Add enemy', enemy_name_ph: 'Enemy name', enemy_hp_ph: 'HP', enemy_atk_ph: 'Atk',
        attack: 'Attack', enemy_hit: 'It hits you', no_enemies: 'No enemies.',
        toast_hit_enemy: 'You hit {name} for {n} ({hp}/{max} left).', toast_enemy_down: '{name} is defeated!',
        toast_enemy_hit: '{name} attacks you ({n} incoming).', toast_need_ename: 'Enter an enemy name.',
        inject_combat: 'In combat — enemies: {list}. {{user}} is {weapon}', inj_weaponed: 'wielding {name} (attack {atk})', inj_unarmed: 'unarmed',
        set_combat_inject: 'Inject combat / enemy state into the prompt', set_combat_depth: 'Combat injection depth:',
        set_combat_auto: 'Let the AI scan the chat for combat (off = narrative only)', set_combat_scan: 'Recent messages to scan for combat (1–10):',
        combat_changed: 'Combat:', c_appears: '{name} appears', c_hit: '{name} −{n}', c_down: '{name} down', c_fled: '{name} fled',
        set_title: 'RPG Vitals (HP & Effects)', set_enable: 'Enable Vitals',
        set_lang: 'Language:', set_depth: 'Context injection depth:', set_maxhp: 'Default max HP:',
        hunger: 'Hunger', feed: 'Feed', set_hungerlbl: 'Set',
        inject_hunger: 'Hunger: {h}/100', inject_starving: "{{user}} is starving (hunger 0) — weak, shaky and desperate for food; play this hunger out now",
        angel_depth: 'Messages the angel reads:',
        angel_offline: 'The records were down. The angel brought its own questions.',
        angel_set: 'Angel of the last hour',
        angel_hint: 'When health reaches zero, an angel appears and asks five questions about the world your character lives in. Two wrong answers are forgiven. Win and you are sent back with 20 health and a blessing; lose and you are offered a new chat — the old one is kept.',
        angel_dead: 'YOU ARE DEAD',
        angel_again: 'No one comes this time. The angel came once, and once was the arrangement.',
        angel_waiting: 'Something is coming for you…',
        angel_q: 'Question {n} of {of}', angel_left: 'mistakes left: {n}',
        angel_next: 'Next', angel_verdict: 'Hear the verdict',
        angel_spared: 'You are sent back.', angel_back: 'Return',
        angel_stay: 'Stay here', angel_restart: 'Begin again',
        angel_kept: 'This chat is not deleted. A new one opens beside it.',
        angel_fail: 'The angel never arrived — the model could not be reached.',
        angel_newchat_manual: 'Start a new chat yourself: this build cannot do it from here.',
        angel_buff_name: 'Angel\'s blessing', angel_buff_eff: 'Sent back from the edge; wounds close faster than they should',
        angel_chat_win: '{name} took pity. The angel sends {{user}} back — alive, against everything.',
        toast_starving: '{{user}} is starving!', toast_fed: 'Fed +{n}.',
        set_hunger: 'Enable hunger (depletes over messages)', set_hunger_every: 'Deplete every N bot messages:', set_hunger_amount: 'Hunger lost each time:', set_starve_dmg: 'HP lost per message while starving:',
        set_autodetect: 'Auto-update HP / hunger / effects from the story', set_gm: 'Show manual controls (GM / override)', set_url: 'API URL:', set_key: 'API Key:', set_model: 'Model:', auto_changed: 'The scene changed your state.',
        lbl_level: 'LEVEL', lbl_mana: 'MANA', lbl_fatigue: 'FATIGUE',
        level_word: 'Level', mana_word: 'Mana', fatigue_word: 'Fatigue', xp: 'XP', set_setlbl: 'Set',
        toast_levelup: 'Level up! You are now level {n}.',
        inject_level: 'Level {n}', inject_mana: 'Mana: {m}/100', inject_fatigue: 'Fatigue: {f}/100 (higher = more tired)',
        set_level: 'Enable level (XP from defeated enemies + AI story milestones, max 100)',
        set_autoexpire: 'Fade effects with no set duration', set_autoexpire_max: 'random up to (messages):',
        set_mana: 'Enable mana (the story raises and spends it)',
        set_fatigue: 'Enable fatigue (rises with exertion, falls with rest)'
    },
    ru: {
        btn_title: 'HP и эффекты', panel_title: 'Состояние',
        hp: 'HP', max: 'Макс', heal: 'Лечить', hurt: 'Урон', set_hp: 'Задать',
        effects: 'Эффекты', add_effect: 'Добавить эффект', name_ph: 'Название эффекта', effect_ph: 'Что делает (необязательно)',
        kind: 'Тип', buff: 'Бафф', debuff: 'Дебафф', duration: 'Ходов', no_effects: 'Активных эффектов нет.',
        remove: 'Убрать', save: 'Сохранить', cancel: 'Отмена', forever: '∞',
        inject_hp: 'HP игрока {{user}}: {hp}/{max}', inject_effects: 'Активные эффекты', inject_effects_note: 'Эти эффекты должны реально влиять на сцену: каждый + даёт {{user}} уместное преимущество, а каждый − — реальную помеху в подходящие моменты (бой, общение, физика), не описывая их как игровой текст на экране',
        toast_restored: 'Показатели восстановлены из резервной копии чата.',
        toast_added: 'Эффект добавлен.', toast_expired: 'Эффект «{name}» прошёл.',
        toast_healed: 'Лечение +{n} HP.', toast_hurt: '−{n} HP.', toast_need_name: 'Введите название эффекта.',
        toast_armor: 'Броня поглотила {n} урона.',
        vex_sub: 'ОСМОТР · MEDICAL', exam_b: 'EXAM', exam_i: 'осмотр', lbl_health: 'ЗДОРОВЬЕ · HP', lbl_satiety: 'СЫТОСТЬ', lbl_effects: 'ЭФФЕКТЫ', clean: 'ЧИСТО', close: 'Закрыть',
        combat: 'Бой', add_enemy: 'Добавить врага', enemy_name_ph: 'Имя врага', enemy_hp_ph: 'HP', enemy_atk_ph: 'Урон',
        attack: 'Атаковать', enemy_hit: 'Удар по мне', no_enemies: 'Врагов нет.',
        toast_hit_enemy: 'Ты бьёшь «{name}» на {n} (осталось {hp}/{max}).', toast_enemy_down: '«{name}» повержен!',
        toast_enemy_hit: '«{name}» атакует тебя (входящий урон {n}).', toast_need_ename: 'Введите имя врага.',
        inject_combat: 'Идёт бой — враги: {list}. {{user}} {weapon}', inj_weaponed: 'с оружием {name} (урон {atk})', inj_unarmed: 'без оружия',
        set_combat_inject: 'Вставлять состояние боя / врагов в подсказку', set_combat_depth: 'Глубина вставки боя:',
        set_combat_auto: 'Разрешить ИИ сканировать чат на бой (выкл = только нарратив)', set_combat_scan: 'Сколько последних сообщений сканировать (1–10):',
        combat_changed: 'Бой:', c_appears: 'появился «{name}»', c_hit: '«{name}» −{n}', c_down: '«{name}» повержен', c_fled: '«{name}» сбежал',
        set_title: 'RPG Vitals (HP и эффекты)', set_enable: 'Включить состояние',
        set_lang: 'Язык:', set_depth: 'Глубина вставки в контекст:', set_maxhp: 'Макс. HP по умолчанию:',
        hunger: 'Сытость', feed: 'Покормить', set_hungerlbl: 'Задать',
        inject_hunger: 'Сытость: {h}/100', inject_starving: '{{user}} голодает (сытость 0) — слаб(а), дрожит и отчаянно ищет еду; обязательно отыграй этот голод сейчас',
        angel_depth: 'Сколько сообщений читает ангел:',
        angel_offline: 'Записи недоступны. Ангел принёс свои вопросы.',
        angel_set: 'Ангел последнего часа',
        angel_hint: 'Когда здоровье падает до нуля, приходит ангел и задаёт пять вопросов о мире, где живёт твой персонаж. Две ошибки прощаются. Выиграешь — вернёшься с 20 здоровья и благословением; проиграешь — предложат новый чат, старый останется.',
        angel_dead: 'ВЫ МЕРТВЫ',
        angel_again: 'В этот раз никто не придёт. Ангел приходил однажды, и однажды было условием.',
        angel_waiting: 'За тобой уже идут…',
        angel_q: 'Вопрос {n} из {of}', angel_left: 'ошибок осталось: {n}',
        angel_next: 'Дальше', angel_verdict: 'Услышать приговор',
        angel_spared: 'Тебя отправляют обратно.', angel_back: 'Вернуться',
        angel_stay: 'Остаться здесь', angel_restart: 'Начать заново',
        angel_kept: 'Этот чат не удаляется. Новый откроется рядом с ним.',
        angel_fail: 'Ангел не пришёл — не удалось достучаться до модели.',
        angel_newchat_manual: 'Создай новый чат сам: эта сборка не умеет отсюда.',
        angel_buff_name: 'Благословение ангела', angel_buff_eff: 'Возвращён с края; раны затягиваются быстрее, чем должны',
        angel_chat_win: '{name} сжалился. Ангел отправляет {{user}} обратно — живым, вопреки всему.',
        toast_starving: '{{user}} голодает!', toast_fed: 'Сытость +{n}.',
        set_hunger: 'Включить голод (убывает по сообщениям)', set_hunger_every: 'Убывает каждые N сообщений бота:', set_hunger_amount: 'Сколько сытости теряется за раз:', set_starve_dmg: 'HP теряется за сообщение при голоде:',
        set_autodetect: 'Авто-обновление HP / сытости / эффектов из сюжета', set_gm: 'Показывать ручные кнопки (GM / override)', set_url: 'API URL:', set_key: 'API-ключ:', set_model: 'Модель:', auto_changed: 'Сцена изменила твоё состояние.',
        lbl_level: 'УРОВЕНЬ', lbl_mana: 'МАНА', lbl_fatigue: 'УСТАЛОСТЬ',
        level_word: 'Уровень', mana_word: 'Мана', fatigue_word: 'Усталость', xp: 'ОП', set_setlbl: 'Задать',
        toast_levelup: 'Новый уровень! Теперь ты {n} уровня.',
        inject_level: 'Уровень {n}', inject_mana: 'Мана: {m}/100', inject_fatigue: 'Усталость: {f}/100 (больше = сильнее устал)',
        set_level: 'Включить уровень (опыт с побеждённых врагов + вехи от ИИ, макс 100)',
        set_autoexpire: 'Гасить эффекты без заданной длительности', set_autoexpire_max: 'рандом до (сообщений):',
        set_mana: 'Включить ману (сюжет её тратит и восполняет)',
        set_fatigue: 'Включить усталость (растёт от нагрузки, падает при отдыхе)'
    }
};
/* {{user}} appears in eight strings — in the prompt injections and in two of the
   notifications — and nothing ever replaced it, so the model and the player both saw
   the literal braces. Substituted here because every string in the extension passes
   through this one function, prompt and interface alike. */
/* Names are escaped before they go into a notification, but toastr shows them as
   text — so an apostrophe arrived as "&#39;" and stayed that way. Escaping is still
   right for anything that lands in the panel's markup; this decodes on the way out. */
function unesc(v) {
    return String(v ?? '')
        .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#x2F;/gi, '/')
        .replace(/&amp;/g, '&');   // last, or the ampersands of the others come back
}

(function () {
    if (!window.toastr || window.toastr.__vitUnesc) return;
    ['success', 'info', 'warning', 'error'].forEach(k => {
        const orig = toastr[k];
        if (typeof orig !== 'function') return;
        toastr[k] = function (msg, title, opts) {
            return orig.call(toastr, unesc(msg), title === undefined ? title : unesc(title), opts);
        };
    });
    window.toastr.__vitUnesc = true;
})();

function playerName() {
    try {
        const ctx = getContext();
        return ctx?.name1 || (typeof window !== 'undefined' && window.name1) || 'User';
    } catch (e) { return 'User'; }
}

function t(key, vars) {
    const lang = settings.language === 'ru' ? 'ru' : 'en';
    let str = (I18N[lang] && I18N[lang][key] !== undefined) ? I18N[lang][key] : (I18N.en[key] !== undefined ? I18N.en[key] : key);
    if (vars) for (const k in vars) str = str.split('{' + k + '}').join(vars[k]);
    // Last, so a value passed in through vars cannot smuggle the macro back in.
    if (str.indexOf('{{user}}') !== -1) str = str.split('{{user}}').join(playerName());
    return str;
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    settings = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME]);
    if (!settings.chatStates) settings.chatStates = {};
    if (!settings.chatStamps) settings.chatStamps = {};
    // heal NaN/garbage that empty number inputs could have saved
    if (!Number.isFinite(settings.injectDepth)) settings.injectDepth = defaultSettings.injectDepth;
    if (settings.combatDepth != null && !Number.isFinite(settings.combatDepth)) settings.combatDepth = defaultSettings.combatDepth;
    if (!Number.isFinite(settings.defaultMaxHp)) settings.defaultMaxHp = defaultSettings.defaultMaxHp;
}
function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

// Per-chat vitals used to live in settings forever, bloating settings.json.
// States untouched for STATE_TTL days are dropped; they remain recoverable
// from the rpg_vitals_checkpoint backup written into the chat itself.
const STATE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
function pruneOldStates() {
    const now = Date.now();
    let changed = false;
    for (const id of Object.keys(settings.chatStates)) {
        if (!settings.chatStamps[id]) { settings.chatStamps[id] = now; changed = true; continue; } // migrate
        if (now - settings.chatStamps[id] > STATE_TTL_MS) {
            delete settings.chatStates[id];
            delete settings.chatStamps[id];
            changed = true;
        }
    }
    for (const id of Object.keys(settings.chatStamps)) {
        if (!settings.chatStates[id]) { delete settings.chatStamps[id]; changed = true; }
    }
    if (changed) saveSettings();
}

function freshState() { return { hp: settings.defaultMaxHp || 100, maxHp: settings.defaultMaxHp || 100, buffs: [], hunger: 100, hungerTick: 0, enemies: [], level: 1, xp: 0, mana: 100, fatigue: 0 }; }

// ---- chat ownership: this state belongs to one chat and is never written into another ----
let currentChatId = null;   // chat the in-memory `state` belongs to
let pendingChatId = null;   // id reported by CHAT_CHANGED, before the state is (re)loaded
let stateReady = false;     // false while switching chats; saving is blocked

function cloneState(s) { try { return JSON.parse(JSON.stringify(s)); } catch (e) { return freshState(); } }
function normalizeState(s) {
    if (typeof s.angelUsed !== 'boolean') s.angelUsed = false;   // one trial per chat
    if (typeof s.hp !== 'number') s.hp = settings.defaultMaxHp || 100;
    if (typeof s.maxHp !== 'number') s.maxHp = settings.defaultMaxHp || 100;
    if (!Array.isArray(s.buffs)) s.buffs = [];
    if (typeof s.hunger !== 'number') s.hunger = 100;
    if (typeof s.hungerTick !== 'number') s.hungerTick = 0;
    if (!Array.isArray(s.enemies)) s.enemies = [];
    if (typeof s.level !== 'number') s.level = 1;
    if (typeof s.xp !== 'number') s.xp = 0;
    if (typeof s.mana !== 'number') s.mana = 100;
    if (typeof s.fatigue !== 'number') s.fatigue = 0;
    // Backfill missing ids (older checkpoints / hand-edited states). Without an
    // id the GM ✕ button can't remove the buff (removeBuff(undefined) no-ops),
    // and in-place repaints select rows by data-bid/data-eid.
    s.buffs = s.buffs.filter(b => b && typeof b === 'object' && b.name);
    s.buffs.forEach(b => { if (!b.id) b.id = genId(); });
    s.enemies = s.enemies.filter(e => e && typeof e === 'object' && e.name);
    s.enemies.forEach(e => { if (!e.id) e.id = genId(); });
    return s;
}

function loadState(explicitId) {
    const chatId = explicitId || pendingChatId || getContext().chatId;
    if (!chatId) { currentChatId = null; pendingChatId = null; stateReady = false; state = freshState(); return; }
    currentChatId = chatId; pendingChatId = null; stateReady = true;
    if (!settings.chatStamps) settings.chatStamps = {};
    settings.chatStamps[chatId] = Date.now();   // touch: keeps this chat's state from being pruned

    if (settings.chatStates[chatId]) {
        state = normalizeState(settings.chatStates[chatId]);
    } else {
        // Restore from the backup kept inside the chat. This is what carries HP, effects and level
        // over when a solo chat is converted to a group: the group gets a new chat id, so chatStates
        // has no entry for it, but the copied messages still carry the backup.
        // A chat holding only the greeting is a copy of nothing and is never restored into.
        const chat = getContext().chat;
        let restored = false;
        if (chat && chat.length > 1) {
            for (let i = chat.length - 1; i >= 0; i--) {
                const cp = chat[i].extra && chat[i].extra.rpg_vitals_checkpoint;
                if (cp && typeof cp === 'object') {
                    state = normalizeState(cloneState(cp));   // copy: never share objects with the chat file
                    restored = true;
                    break;
                }
            }
        }
        if (!restored) state = freshState();
        settings.chatStates[chatId] = state;
        if (restored) { saveSettings(); toastr.success(t('toast_restored')); }
    }
}

function saveState() {
    if (!stateReady || !currentChatId) return;                 // mid-switch: do not write
    const ctx = getContext();
    if (ctx.chatId && ctx.chatId !== currentChatId) return;    // state belongs to a chat we left
    settings.chatStates[currentChatId] = state;
    if (!settings.chatStamps) settings.chatStamps = {};
    settings.chatStamps[currentChatId] = Date.now();
    saveSettings();

    // Backup inside the chat itself, as a copy. This is what survives a group conversion.
    try {
        const chat = ctx.chat;
        if (chat && chat.length > 0) {
            const lastMsg = chat[chat.length - 1];
            if (!lastMsg.extra) lastMsg.extra = {};
            lastMsg.extra.rpg_vitals_checkpoint = cloneState(state);
            saveChatDebounced();
        }
    } catch (e) { console.error('[Vitals] checkpoint save failed:', e); }
}

// Ensure the state for the active chat is loaded before it is touched.
function syncChat() {
    const id = pendingChatId || getContext().chatId;
    if (!id) return;
    if (!stateReady || id !== currentChatId) loadState(id);
}
// True while the loaded state still belongs to the active chat. Guards async work.
function ownsChat(id) { return !!(stateReady && id && currentChatId === id && getContext().chatId === id); }

function clampHp() {
    state.hp = Math.max(0, Math.min(state.maxHp || 100, Math.round(state.hp)));
    // Every path that changes health passes through here — damage read from a message,
    // the panel, another extension — so the trial is triggered from one place instead
    // of being remembered at each of them. Deferred a tick so the caller finishes
    // saving and redrawing before a full-screen card appears over it.
    if (state.hp <= 0 && !angelState && typeof angelCheckDeath === 'function') setTimeout(() => { try { angelCheckDeath(); } catch (e) { console.error('[RPG Vitals] angel:', e); } }, 0);
}
function clampHunger() { state.hunger = Math.max(0, Math.min(100, Math.round(state.hunger))); }
function feed(n) {
    if (!state || !settings.hungerEnabled) return 0;
    if (typeof state.hunger !== 'number') state.hunger = 100;
    const before = state.hunger;
    state.hunger += Math.abs(n || 0); clampHunger(); saveState(); renderPanel(); buildInjection();
    return state.hunger - before;
}
function setHunger(n) { if (!state) return; state.hunger = n; clampHunger(); saveState(); renderPanel(); buildInjection(); }

// ---- level / mana / fatigue (all optional, AI-driven like hunger) ----
const MAX_LEVEL = 100;
const XP_PER_LEVEL = 100;
function addXp(n) {
    if (!settings.levelEnabled || !state) return;
    n = Math.round(n || 0);
    if (n === 0) return;
    if (typeof state.level !== 'number') state.level = 1;
    if (typeof state.xp !== 'number') state.xp = 0;
    if (state.level >= MAX_LEVEL) { state.xp = XP_PER_LEVEL; saveState(); renderPanel(); return; }
    state.xp += n;
    while (state.xp >= XP_PER_LEVEL && state.level < MAX_LEVEL) {
        state.xp -= XP_PER_LEVEL;
        state.level += 1;
        toastr.success(t('toast_levelup', { n: state.level }));
    }
    if (state.level >= MAX_LEVEL) { state.level = MAX_LEVEL; state.xp = Math.min(state.xp, XP_PER_LEVEL); }
    if (state.xp < 0) state.xp = 0;
    saveState(); renderPanel(); buildInjection();
}
function gainKillXp(enemy) {
    if (!settings.levelEnabled || !enemy) return;
    const val = Math.max(5, Math.min(80, Math.round((enemy.max || 10) * 0.6 + (enemy.atk || 0) * 2)));
    addXp(val);
}
function clampMana() { state.mana = Math.max(0, Math.min(100, Math.round(state.mana))); }
function setMana(n) { if (!state) return; state.mana = n; clampMana(); saveState(); renderPanel(); buildInjection(); }
function addMana(n) { if (!state) return; if (typeof state.mana !== 'number') state.mana = 100; state.mana += Math.round(n || 0); clampMana(); saveState(); renderPanel(); buildInjection(); }
function clampFatigue() { state.fatigue = Math.max(0, Math.min(100, Math.round(state.fatigue))); }
function setFatigue(n) { if (!state) return; state.fatigue = n; clampFatigue(); saveState(); renderPanel(); buildInjection(); }
function addFatigue(n) { if (!state) return; if (typeof state.fatigue !== 'number') state.fatigue = 0; state.fatigue += Math.round(n || 0); clampFatigue(); saveState(); renderPanel(); buildInjection(); }
function heal(n) { state.hp += Math.abs(n || 0); clampHp(); saveState(); renderPanel(); buildInjection(); }
function damage(n) {
    const raw = Math.abs(n || 0);
    let dmg = raw;
    try {
        const eq = (window.RPG && window.RPG.equipment && window.RPG.equipment.available) ? window.RPG.equipment : null;
        if (raw > 0 && eq && eq.isEnabled && eq.isEnabled() && (!eq.affectsHp || eq.affectsHp()) && typeof eq.defense === 'function') {
            const def = eq.defense() || 0;
            if (def > 0) {
                const blocked = Math.min(def, Math.max(0, dmg - 1)); // a hit always grazes for at least 1
                if (blocked > 0) { dmg -= blocked; toastr.info(t('toast_armor', { n: blocked })); }
            }
        }
    } catch (e) { /* equipment optional — never block damage on error */ }
    state.hp -= dmg; clampHp(); saveState(); renderPanel(); buildInjection();
}
function setHp(n, max) {
    if (typeof max === 'number' && max > 0) state.maxHp = Math.round(max);
    if (typeof n === 'number') state.hp = n;
    clampHp(); saveState(); renderPanel(); buildInjection();
}
function addBuff(b) {
    if (!b || !b.name) return null;
    let dur = (typeof b.duration === 'number' && b.duration > 0) ? Math.round(b.duration) : null;
    // No explicit duration → optionally fade after a random number of messages.
    // Tagged buffs (e.g. worn equipment) are "sticky" — they never auto-fade; they're removed explicitly.
    if (dur == null && settings.autoExpire && !b.tag) {
        const maxN = Math.max(1, parseInt(settings.autoExpireMax) || 20);
        dur = 1 + Math.floor(Math.random() * maxN); // 1..maxN
    }
    const buff = {
        id: genId(), name: String(b.name), effect: String(b.effect || ''),
        kind: (b.kind === 'debuff') ? 'debuff' : 'buff',
        duration: dur, // null = until removed
        tag: b.tag ? String(b.tag) : undefined // optional owner tag (e.g. "eq:weapon") for later removal
    };
    state.buffs.push(buff); saveState(); renderPanel(); buildInjection();
    return buff;
}
// remove by buff id, or by owner tag, or by exact name (first match wins for name)
function removeBuff(key) {
    if (!state || key == null) return;
    const before = state.buffs.length;
    if (state.buffs.some(b => b.tag && b.tag === key)) state.buffs = state.buffs.filter(b => b.tag !== key);
    else if (state.buffs.some(b => b.id === key)) state.buffs = state.buffs.filter(b => b.id !== key);
    else { const i = state.buffs.findIndex(b => b.name === key); if (i >= 0) state.buffs.splice(i, 1); }
    if (state.buffs.length !== before) { saveState(); renderPanel(); buildInjection(); }
}

// ---- combat / enemies ----
function playerAttackPower() {
    let base = 2; // unarmed
    try {
        const eq = (window.RPG && window.RPG.equipment && window.RPG.equipment.available) ? window.RPG.equipment : null;
        if (eq && eq.isEnabled && eq.isEnabled() && typeof eq.attack === 'function') { const a = eq.attack() || 0; if (a > 0) base = a; }
    } catch (e) { /* equipment optional */ }
    return Math.max(1, Math.round(base * (0.8 + Math.random() * 0.4))); // ±20% swing
}
function addEnemy(name, hp, atk) {
    if (!name) return null;
    const m = Math.max(1, parseInt(hp) || 20);
    const e = { id: genId(), name: String(name), hp: m, max: m, atk: Math.max(0, parseInt(atk) || 5) };
    state.enemies.push(e); saveState(); renderPanel(); buildInjection();
    return e;
}
function removeEnemy(id) { state.enemies = state.enemies.filter(e => e.id !== id); saveState(); renderPanel(); buildInjection(); }
// "Soldier 1", "Soldier 2"… share a stem — the model numbers them because names must be
// unique. Group them for display and for the injection; individuals stay underneath.
function enemyStem(name) { return String(name || '').replace(/\s*[#№]?\d+$/, '').trim().toLowerCase(); }
function groupedEnemies() {
    const groups = [];
    const byStem = {};
    for (const e of state.enemies) {
        const k = enemyStem(e.name) || e.name.toLowerCase();
        if (!byStem[k]) { byStem[k] = { stem: k, members: [] }; groups.push(byStem[k]); }
        byStem[k].members.push(e);
    }
    return groups.map(g => {
        const first = g.members[0];
        const label = g.members.length > 1
            ? `${String(first.name).replace(/\s*[#№]?\d+$/, '').trim()} ×${g.members.length}`
            : first.name;
        return {
            label,
            repId: first.id,
            count: g.members.length,
            hp: g.members.reduce((a, e) => a + e.hp, 0),
            max: g.members.reduce((a, e) => a + (e.max || 0), 0),
            atk: first.atk,
            members: g.members
        };
    });
}
function groupOf(repId) {
    const e = state.enemies.find(x => x.id === repId); if (!e) return [];
    const k = enemyStem(e.name) || e.name.toLowerCase();
    return state.enemies.filter(x => (enemyStem(x.name) || x.name.toLowerCase()) === k);
}

function attackEnemy(id) {
    // attacking a group hits its weakest member — kills finish cleanly, the ×N shrinks
    const g = groupOf(id);
    const e = g.length ? g.reduce((a, b) => (a.hp <= b.hp ? a : b)) : state.enemies.find(x => x.id === id);
    if (!e) return;
    id = e.id;
    const dmg = playerAttackPower();
    e.hp = Math.max(0, e.hp - dmg);
    const safeName = escapeHtml(e.name);   // AI-provided name goes into a toast (toastr renders HTML)
    if (e.hp <= 0) {
        toastr.success(t('toast_hit_enemy', { name: safeName, n: dmg, hp: 0, max: e.max }));
        toastr.warning(t('toast_enemy_down', { name: safeName }));
        gainKillXp(e);
        state.enemies = state.enemies.filter(x => x.id !== id);
    } else {
        toastr.info(t('toast_hit_enemy', { name: safeName, n: dmg, hp: e.hp, max: e.max }));
    }
    saveState(); renderPanel(); buildInjection();
}
function enemyHitsYou(id) {
    const e = state.enemies.find(x => x.id === id); if (!e) return;
    toastr.warning(t('toast_enemy_hit', { name: escapeHtml(e.name), n: e.atk || 0 }));
    damage(e.atk || 0); // armour from equipment soaks part of it inside damage()
}

function genLang() { return settings.language === 'ru' ? 'Russian' : 'English'; }
/* ------------------------------------------------------------
   ENDPOINT HANDLING — reaching the server only. Nothing about vitals, damage,
   hunger, combat or any prompt changes here.

   1. An empty key falls back to Tavern RPG Engine's. An address YOU typed always
      wins: borrowing takes only what is missing, never the URL. A local backend
      needs no key, so a placeholder is used rather than a borrowed one.
   2. OpenAI-style backends live under /v1. Without it the request goes to
      /chat/completions, which LM Studio and KoboldCpp reject as an unknown path.
   3. response_format is an OpenAI parameter. KoboldCpp turns it into a grammar
      that forbids anything but an object, so a model opening with "[" bails out
      with EOS. Local backends do not get it — the reply is parsed leniently anyway.
   ------------------------------------------------------------ */
const KEY_SOURCES = ['tavern_rpg_engine'];
function normalizeBase(url) {
    let u = String(url || '').trim().replace(/\s+/g, '');
    if (!u) return u;
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/(chat\/completions|completions|images|images\/generations|embeddings)$/i, '');
    if (!/\/v\d+($|\/)/i.test(u)) u += '/v1';
    return u;
}
function isLocalEndpoint(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)([:/]|$)/.test(u)
        || /:(5001|5000|8080|8000|1234|11434|5002)(\/|$)/.test(u)
        || /192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./.test(u);
}
function wantsStrictJson(url) {
    if (settings.strictJson === false) return false;
    return !isLocalEndpoint(url);
}
function borrowedRaw() {
    for (const src of KEY_SOURCES) {
        if (src === MODULE_NAME) continue;
        try {
            const x = extension_settings[src];
            if (x && x.apiKey && x.model) return { url: x.baseUrl, key: x.apiKey, model: x.model, from: src };
        } catch (e) { /* a neighbour with broken settings must not break us */ }
    }
    return { url: '', key: '', model: '', from: null };
}
function apiConf() {
    const own = String(settings.baseUrl || '').trim();
    const ownKey = String(settings.apiKey || '').trim();
    const ownModel = String(settings.model || '').trim();
    if (own) {
        const local = isLocalEndpoint(own);
        const b = (ownKey && ownModel) ? { key: '', model: '', from: null } : borrowedRaw();
        return {
            url: own,
            key: ownKey || (local ? 'local' : b.key),
            model: ownModel || (local ? '' : b.model),
            from: ownKey ? null : (local ? null : b.from)
        };
    }
    if (ownKey && ownModel) return { url: '', key: ownKey, model: ownModel, from: null };
    const b = borrowedRaw();
    return b.key ? b : { url: '', key: ownKey, model: ownModel, from: null };
}
function apiKey() { return apiConf().key || ''; }
function apiUrl() { return normalizeBase(apiConf().url) || 'https://openrouter.ai/api/v1'; }
function apiModel() { return apiConf().model || ''; }
function borrowedFrom() { return apiConf().from; }

async function callAI(systemPrompt, userPrompt) {
    if (!apiKey()) throw new Error('API key is not set!');
    const endpointUrl = apiUrl() + '/chat/completions';
    for (let i = 0; i < 2; i++) {
        try {
            const response = await fetch(endpointUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey().trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: apiModel(),
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                    temperature: settings.temperature,
                    ...(wantsStrictJson(endpointUrl) ? { response_format: { type: 'json_object' } } : {})
                })
            });
            if (response.status === 429 && i === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const content = data.choices[0].message.content.trim();
            const m = content.match(/\{[\s\S]*\}/);
            return JSON.parse(m ? m[0] : content);
        } catch (e) { if (i === 1) throw e; }
    }
}
const EAT_RE = /\b(eat|eats|eating|ate|drink|drinks|drinking|drank|bite|bites|chew|chews|swallow|swallows|sip|sips|munch|devour|feast|gulp|nibble)\b|съе(л|ла|сть|ем|шь)|\bест\b|поел|перекус|откус|кус(аю|нул)|жу(ю|ёт)|пь(ю|ёт)|пил[аои]?\b|выпи|глот|хлебн|заеда/i;
function mentionsEating(text) { return EAT_RE.test(String(text || '')); }
// healing / rest / mana actions the PLAYER may narrate about themselves
const CARE_RE = /\b(bandag|patch(ed|es|ing)? up|dress(ed|ing)? the wound|tend(ed|ing)?|stitch|heal|rest|sleep|slept|nap|recover|recuperat|meditat|catch (my|her|his) breath|first aid|salve|ointment|potion|drink.*potion)\b|перевяз|перевязк|перевязал|обработал.*ран|заклеил|зашил|бинт|лечу|лечит|лечен|исцел|отдых|отдохн|поспал|вздремн|передохн|восстанавлив|отлежал|медитир|отдышал|мазь|зель[ея]|снадоб/i;
function mentionsCare(text) { return CARE_RE.test(String(text || '')); }

async function analyzeMessage(messageId, opts) {
    opts = opts || {};
    if (!settings.enabled || !settings.autoDetect || !apiKey() || !state) return;
    const myChat = currentChatId;
    const msg = getContext().chat[messageId];
    if (!msg || msg.is_system || !msg.mes) return;
    if (msg.is_user && !opts.selfReport) return; // the normal scan ignores the player's own message
    if (opts.selfReport) {
        // the PLAYER narrated something about themselves — catch self-care they'd control: eating, and tending/resting
        const eats = settings.hungerEnabled && mentionsEating(msg.mes);
        const cares = mentionsCare(msg.mes);
        if (!eats && !cares) return;
        if (vitalsBusy) return; // never stack analyses — this is what caused freezes after eating
        vitalsBusy = true;
        try {
            const whoS = getContext().name1 || 'the player';
            const askSat = settings.hungerEnabled ? `\n"satiety_delta": satiety GAINED by eating/drinking THIS message — POSITIVE 0..40 (snack ~10, meal ~30, drink ~5-15), else 0.` : '';
            const askMana = settings.manaEnabled ? `\n"mana_delta": mana RECOVERED by resting/meditating/a potion THIS message — POSITIVE 0..40, else 0.` : '';
            const askFat = settings.fatigueEnabled ? `\n"fatigue_delta": NEGATIVE if they rested/slept (recovered), 0 otherwise.` : '';
            const sysS = `The player "${whoS}" (currently ${state.hp}/${state.maxHp} HP) just narrated an action about THEMSELVES. Report only self-care they actually did.
"hp_delta": HP RECOVERED by tending a wound / first aid / resting / a healing potion THIS message — a POSITIVE, REALISTIC number. Basic first aid or a bandage restores only a LITTLE (about 5-15); real rest or a good remedy more (15-35); a potent healing potion most. It must NEVER fully heal from one ordinary bandage. 0 if no real healing happened.${askSat}${askMana}${askFat}
Optionally "add_effects": one short effect if clearly granted (e.g. "Bandaged", "Rested"), else empty.
Write effect names in ${genLang()}. Output strictly JSON: {"hp_delta":0${settings.hungerEnabled ? ',"satiety_delta":0' : ''}${settings.manaEnabled ? ',"mana_delta":0' : ''}${settings.fatigueEnabled ? ',"fatigue_delta":0' : ''},"add_effects":[]}`;
            const resS = await callAI(sysS, String(msg.mes).slice(0, 1500));
            if (!ownsChat(myChat)) return;   // chat changed during the request
            if (!resS) return;
            const notesS = [];
            const hd = parseInt(resS.hp_delta);
            if (hd > 0) { heal(Math.min(hd, 40)); notesS.push(`${t('hp')} +${Math.min(hd, 40)}`); }
            const sd = parseInt(resS.satiety_delta);
            if (settings.hungerEnabled && sd > 0) { feed(sd); notesS.push(`${t('lbl_satiety')} +${sd}`); }
            const md = parseInt(resS.mana_delta);
            if (settings.manaEnabled && md > 0) { addMana(md); notesS.push(`${t('lbl_mana')} +${md}`); }
            const fd = parseInt(resS.fatigue_delta);
            if (settings.fatigueEnabled && fd < 0) { addFatigue(fd); notesS.push(`${t('lbl_fatigue')} ${fd}`); }
            for (const e of (Array.isArray(resS.add_effects) ? resS.add_effects : [])) if (e && e.name) { addBuff(e); notesS.push('+' + escapeHtml(e.name)); }
            if (notesS.length) toastr.info(t('auto_changed') + ' ' + notesS.join(', '));
        } catch (e) { /* silent */ } finally { vitalsBusy = false; }
        return;
    }
    if (vitalsBusy) return; // don't run the story scan while another analysis is in flight
    vitalsBusy = true;
    try {
        const effList = state.buffs.map(b => b.name).join(', ') || 'none';
        const hungerInfo = settings.hungerEnabled ? `, hunger ${state.hunger}/100` : '';
        const manaInfo = settings.manaEnabled ? `, mana ${state.mana}/100` : '';
        const fatigueInfo = settings.fatigueEnabled ? `, fatigue ${state.fatigue}/100` : '';
        const lvlInfo = settings.levelEnabled ? `, level ${state.level}` : '';
        const who = getContext().name1 || 'the player';
        const partner = getContext().name2 || '';

        // build the JSON schema + rules only for the enabled optional stats
        let fields = '"hp_delta":0,"add_effects":[{"name":"","effect":"","kind":"buff","duration":3}],"remove_effects":[]';
        let rules = `\n- "hp_delta": negative if "${getContext().name1 || 'the player'}" got physically HURT this message (a scratch ~3-8, a solid wound ~10-25, a grave injury ~30-45), positive if they actually healed (bandage ~5-15, treatment/rest ~15-35). 0 if neither.`;
        if (settings.hungerEnabled) { fields += ',"satiety_delta":0'; rules += `\n- "satiety_delta": +N when "${who}" EATS or DRINKS this message (fuller: a snack ~10, a meal ~30, a drink ~5-15). Eating or drinking is ALWAYS positive. Use a negative number ONLY if the text explicitly shows a long stretch with no food at all. Otherwise 0.`; }
        if (settings.manaEnabled) { fields += ',"mana_delta":0'; rules += `\n- "mana_delta": mana "${who}" spent (negative, e.g. casting/using magic) or recovered (positive, e.g. rest/potion/meditation) THIS message.`; }
        if (settings.fatigueEnabled) { fields += ',"fatigue_delta":0'; rules += `\n- "fatigue_delta": how much MORE tired "${who}" got (positive: hard exertion, fighting, sprinting, no sleep) or how much they recovered (negative: rest/sleep) THIS message.`; }
        if (settings.levelEnabled) { fields += ',"xp_delta":0'; rules += `\n- "xp_delta": experience for a real achievement by "${who}" THIS message (finishing a quest, a big victory, a breakthrough) — usually 0, occasionally 10–40. Do NOT award xp just for talking.`; }

        const sys = `You track the physical state of "${who}" (the player/user) in a roleplay. ${partner ? `"${partner}" is the scene character, NOT "${who}" — report only what changed for "${who}", never for "${partner}".` : ''} Read ONLY the latest scene text and report what actually changed for "${who}" in THIS message.
Be conservative: most messages change nothing — then return zeros and empty arrays. Only react to clear events (taking a hit, healing/resting, eating/drinking, being poisoned/drunk/blessed/exhausted, an effect ending).
Current HP ${state.hp}/${state.maxHp}${hungerInfo}${manaInfo}${fatigueInfo}${lvlInfo}. Current effects: ${effList}.${rules}
Write any effect names/descriptions in ${genLang()}.
Output strictly JSON: {${fields}}`;
        const res = await callAI(sys, String(msg.mes).slice(0, 2000));
        if (!ownsChat(myChat)) return;   // chat changed during the request
        if (!res) return;
        const notes = [];
        if (typeof res.hp_delta === 'number' && res.hp_delta !== 0) {
            let hpd = res.hp_delta;
            // skip narrative damage ONLY when the combat scan already subtracted damage for
            // this very message; otherwise story wounds (traps, falls, ambush narration)
            // never reached HP at all with combatAuto on
            if (hpd < 0 && settings.combatAuto && opts && opts.combatDmg > 0) hpd = 0;
            if (hpd > 0) { heal(hpd); notes.push(`HP +${hpd}`); }
            else if (hpd < 0) { damage(-hpd); notes.push(`HP ${hpd}`); }
        }
        if (settings.hungerEnabled && typeof res.satiety_delta === 'number' && res.satiety_delta !== 0) { setHunger(state.hunger + res.satiety_delta); notes.push(`${t('lbl_satiety')} ${res.satiety_delta > 0 ? '+' : ''}${res.satiety_delta}`); }
        if (settings.manaEnabled && typeof res.mana_delta === 'number' && res.mana_delta !== 0) { addMana(res.mana_delta); notes.push(`${t('mana_word')} ${res.mana_delta > 0 ? '+' : ''}${res.mana_delta}`); }
        if (settings.fatigueEnabled && typeof res.fatigue_delta === 'number' && res.fatigue_delta !== 0) { addFatigue(res.fatigue_delta); notes.push(`${t('fatigue_word')} ${res.fatigue_delta > 0 ? '+' : ''}${res.fatigue_delta}`); }
        if (settings.levelEnabled && typeof res.xp_delta === 'number' && res.xp_delta > 0) { addXp(res.xp_delta); notes.push(`${t('xp')} +${res.xp_delta}`); }
        for (const e of (Array.isArray(res.add_effects) ? res.add_effects : [])) if (e && e.name) { addBuff(e); notes.push((e.kind === 'debuff' ? '−' : '+') + escapeHtml(e.name)); }
        for (const nm of (Array.isArray(res.remove_effects) ? res.remove_effects : [])) { const b = state.buffs.find(x => x.name === nm); if (b) removeBuff(b.id); }
        if (notes.length) toastr.info(t('auto_changed') + ' ' + notes.join(', '));
    } catch (e) { /* silent: don't disrupt chat on API errors */ } finally { vitalsBusy = false; }
}
async function analyzeCombat(messageId) {
    if (!settings.enabled || !settings.combatAuto || !apiKey() || !state) return 0;
    const myChat = currentChatId;
    const ctx = getContext();
    const msg = ctx.chat[messageId];
    if (!msg || msg.is_user || msg.is_system || !msg.mes) return 0;
    try {
        // feed the last N messages so the model has the flow of the fight
        const n = Math.max(1, Math.min(10, settings.combatScanMsgs || 4));
        const recent = (ctx.chat || []).slice(-n).filter(m => m && !m.is_system && m.mes)
            .map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || 'Char')}: ${String(m.mes).slice(0, 600)}`).join('\n');
        const roster = state.enemies.length ? state.enemies.map(e => `${e.name} (${e.hp}/${e.max} HP)`).join(', ') : 'none';
        const who = ctx.name1 || 'the player';
        const partner = ctx.name2 || '';
        let atk = 0, def = 0;
        try {
            const eq = (window.RPG && window.RPG.equipment && window.RPG.equipment.available) ? window.RPG.equipment : null;
            if (eq && eq.isEnabled && eq.isEnabled()) { if (eq.attack) atk = eq.attack() || 0; if (eq.defense) def = eq.defense() || 0; }
        } catch (e) {}
        const sys = `You are a COMBAT tracker for a roleplay. The PLAYER you track is "${who}" (the user). ${partner ? `"${partner}" is the scene character/narrator, NOT the player — never treat "${partner}" as "${who}", and only count "${partner}" as an enemy if they are actually fighting "${who}".` : ''}
Read the recent scene and report ONLY what changed in the fight in the LATEST message. If there is no fighting, return empty arrays and 0 — most messages are not combat.
Currently tracked enemies: ${roster}. "${who}"'s weapon attack ≈ ${atk}, armour ≈ ${def}.
Rules — everything below is about "${who}" the player, NOT any other character:
- "new_enemies": foes that just ENTER the fight against "${who}" now (not ones already tracked). Give each a name, rough "hp" (a weak thug ~12, a soldier ~25, a beast ~40, a boss ~80) and "atk" (light ~4, normal ~8, heavy ~15).
- "hits_on_enemies": damage dealt TO a tracked enemy this message — match by name, give "dmg".
- "damage_to_player": total HP that "${who}" PERSONALLY lost to enemies this message (raw, before armour) — integer. HP lost by anyone other than "${who}" does not count.
- "fled": names of enemies that died, fled, were left behind, or that "${who}" escaped / ran away from in the recent messages. If "${who}" clearly escaped or the encounter is over (they left the area, the threat is gone), include ALL currently tracked enemies here so stale enemies are cleared.
Write enemy names in ${genLang()}.
Output strictly JSON: {"new_enemies":[{"name":"","hp":20,"atk":8}],"hits_on_enemies":[{"name":"","dmg":0}],"damage_to_player":0,"fled":[]}`;
        const res = await callAI(sys, recent);
        if (!ownsChat(myChat)) return 0;   // chat changed during the request
        if (!res) return 0;
        const notes = [];
        for (const e of (Array.isArray(res.new_enemies) ? res.new_enemies : [])) {
            if (e && e.name && !state.enemies.some(x => x.name.toLowerCase() === String(e.name).toLowerCase())) {
                addEnemy(e.name, e.hp, e.atk); notes.push(t('c_appears', { name: escapeHtml(e.name) }));
            }
        }
        for (const h of (Array.isArray(res.hits_on_enemies) ? res.hits_on_enemies : [])) {
            if (!h || !h.name || !(h.dmg > 0)) continue;
            const e = state.enemies.find(x => x.name.toLowerCase() === String(h.name).toLowerCase());
            if (!e) continue;
            e.hp = Math.max(0, e.hp - Math.round(h.dmg));
            if (e.hp <= 0) { gainKillXp(e); state.enemies = state.enemies.filter(x => x.id !== e.id); notes.push(t('c_down', { name: escapeHtml(e.name) })); }
            else notes.push(t('c_hit', { name: escapeHtml(e.name), n: Math.round(h.dmg) }));
        }
        for (const nm of (Array.isArray(res.fled) ? res.fled : [])) {
            const before = state.enemies.length;
            state.enemies = state.enemies.filter(x => x.name.toLowerCase() !== String(nm).toLowerCase());
            if (state.enemies.length < before) notes.push(t('c_fled', { name: escapeHtml(nm) }));
        }
        // incoming damage goes through armour (mitigation + wear handled inside damage())
        let dmgApplied = 0;
        if (typeof res.damage_to_player === 'number' && res.damage_to_player > 0) {
            dmgApplied = Math.round(res.damage_to_player);
            damage(dmgApplied);
        }
        saveState(); renderPanel(); buildInjection();
        if (notes.length) toastr.info(t('combat_changed') + ' ' + notes.join(', '));
        return dmgApplied;   // lets the narrative scan know combat already took this message's damage
    } catch (e) { /* silent: never disrupt chat on API errors */ }
    return 0;
}
function tickBuffs(messageId) {
    if (!settings.enabled || !state) return;
    const msg = getContext().chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    const expired = [];   // collect ALL that wore off this tick, not just the last one
    state.buffs = state.buffs.filter(b => {
        if (b.duration == null) return true;
        b.duration -= 1;
        if (b.duration <= 0) { expired.push(b.name); return false; }
        return true;
    });
    // hunger drain by bot messages
    if (settings.hungerEnabled) {
        if (typeof state.hunger !== 'number') state.hunger = 100;
        state.hungerTick = (state.hungerTick || 0) + 1;
        const every = Math.max(1, settings.hungerDrainEvery || 3);
        if (state.hungerTick >= every) {
            state.hungerTick = 0;
            state.hunger = Math.max(0, state.hunger - (settings.hungerDrainAmount || 5));
            if (state.hunger === 0) {
                state.hp = Math.max(0, state.hp - (settings.starveDamage || 0));
                toastr.warning(t('toast_starving'));
            }
        }
    }
    saveState(); renderPanel(); buildInjection();
    for (const name of expired) toastr.info(t('toast_expired', { name: escapeHtml(name) }));
}

// A bot turn's consequences (buff ticks, hunger drain, AI HP/effect/combat analysis) must apply
// EXACTLY ONCE per message. Swiping or regenerating re-fires MESSAGE_RECEIVED for the same message,
// which previously stacked every change again. A per-message marker makes it idempotent.
function onBotMessage(id) {
    syncChat();   // tick/analyze against the chat the message actually belongs to
    const msg = getContext().chat[id];
    if (!msg || msg.is_user || msg.is_system) return;
    if (msg.rpg_vitals_done === true) return; // already handled — this fire is a swipe / regen
    msg.rpg_vitals_done = true;               // mark up-front so re-entrant fires are ignored too
    tickBuffs(id);
    // combat first: the narrative scan then only skips damage that combat ALREADY took.
    // Previously combatAuto discarded ALL narrative damage — a story wound outside a
    // tracked fight (a trap, a fall, an ambush) left HP untouched ("wounded at HP 99").
    analyzeCombat(id).then(dmg => analyzeMessage(id, { combatDmg: dmg || 0 })).catch(() => analyzeMessage(id));
}
function onUserMessage(id) {
    syncChat();
    const msg = getContext().chat[id];
    if (!msg || msg.rpg_vitals_self_done === true) return;
    if (msg) msg.rpg_vitals_self_done = true;
    analyzeMessage(id, { selfReport: true });
}

function buildInjection() {
    if (!settings.enabled || !state || settings.injectDepth < 0) {
        setExtensionPrompt(PROMPT_KEY, '', 2, 0, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(PROMPT_KEY_STARVE, '', 2, 0, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(PROMPT_KEY_COMBAT, '', 2, 0, false, extension_prompt_roles.SYSTEM); return;
    }
    let parts = [t('inject_hp', { hp: state.hp, max: state.maxHp })];
    if (settings.levelEnabled) parts.push(t('inject_level', { n: state.level }));
    if (state.buffs.length) {
        const list = state.buffs.map(b => {
            const sign = b.kind === 'debuff' ? '−' : '+';
            const dur = b.duration == null ? '' : ` (${b.duration})`;
            return `${sign}${b.name}${b.effect ? ': ' + b.effect : ''}${dur}`;
        }).join('; ');
        parts.push(`${t('inject_effects')}: ${list}`);
        parts.push(t('inject_effects_note'));
    }
    if (settings.hungerEnabled && typeof state.hunger === 'number') parts.push(t('inject_hunger', { h: state.hunger }));
    if (settings.manaEnabled && typeof state.mana === 'number') parts.push(t('inject_mana', { m: state.mana }));
    if (settings.fatigueEnabled && typeof state.fatigue === 'number') parts.push(t('inject_fatigue', { f: state.fatigue }));
    setExtensionPrompt(PROMPT_KEY, `\n[${parts.join('. ')}.]\n`, 2, settings.injectDepth, false, extension_prompt_roles.SYSTEM);
    // starving — emphatic note at the very END (depth 0), right before the reply
    const starving = settings.hungerEnabled && state.hunger === 0;
    setExtensionPrompt(PROMPT_KEY_STARVE, starving ? `\n[${t('inject_starving')}.]\n` : '', 2, 0, false, extension_prompt_roles.SYSTEM);

    // combat — only when there are enemies, and only if the user opted in
    let combatText = '';
    if (settings.combatInject && Array.isArray(state.enemies) && state.enemies.length) {
        const list = groupedEnemies().map(g => `${g.label} ${g.hp}/${g.max}`).join(', ');
        let weapon = t('inj_unarmed');
        try {
            const eq = (window.RPG && window.RPG.equipment && window.RPG.equipment.available) ? window.RPG.equipment : null;
            if (eq && eq.isEnabled && eq.isEnabled() && typeof eq.attack === 'function') {
                const a = eq.attack() || 0;
                const w = (typeof eq.list === 'function') ? (eq.list().find(x => x.slot === 'weapon') || {}).item : null;
                if (a > 0 && w) weapon = t('inj_weaponed', { name: w.name, atk: a });
            }
        } catch (e) { /* equipment optional */ }
        const d = (typeof settings.combatDepth === 'number') ? settings.combatDepth : settings.injectDepth;
        combatText = `\n[${t('inject_combat', { list, weapon })}.]\n`;
        setExtensionPrompt(PROMPT_KEY_COMBAT, combatText, 2, Math.max(0, d), false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(PROMPT_KEY_COMBAT, '', 2, 0, false, extension_prompt_roles.SYSTEM);
    }
}

// ============================ UI ============================
function hungerColor() {
    const h = state.hunger;
    if (h > 50) return '#c9a44a';
    if (h > 20) return '#cf8a2e';
    return '#b0432f';
}
function hpColor() {
    const r = state.hp / (state.maxHp || 100);
    if (r > 0.6) return '#6f9355';
    if (r > 0.3) return '#e0a32e';
    return '#c0392b';
}
function renderButton() {
    if ($('#rpg-vit-btn').length === 0) {
        $('body').append(`<div class="rpg-floating-btn" id="rpg-vit-btn" title="${escapeHtml(t('btn_title'))}"><i class="fa-solid fa-heart-pulse"></i></div>`);
    }
    if ($('#rpg-vit-modal').length === 0) {
        $('body').append(`
            <div class="rpg-modal rpg-vit-modal" id="rpg-vit-modal">
                <div class="rpg-modal-header" id="rpg-vit-drag"><span><i class="fa-solid fa-heart-pulse"></i> <span id="rpg-vit-title">${escapeHtml(t('panel_title'))}</span></span> <i class="fa-solid fa-xmark rpg-modal-close"></i></div>
                <div class="rpg-vit-body" id="rpg-vit-body"></div>
            </div>`);
        makeModalDraggable(document.getElementById('rpg-vit-modal'), document.getElementById('rpg-vit-drag'));
        // Delegated + namespaced: a direct element binding here used to be stripped
        // by sibling extensions doing a blanket $('.rpg-modal-close').off('click').
        $(document).off('click.rpgVitClose').on('click.rpgVitClose', '#rpg-vit-modal .rpg-modal-close', () => $('#rpg-vit-modal').removeClass('visible'));
        window.addEventListener('resize', () => { if ($('#rpg-vit-modal').hasClass('visible')) fitCard(); });
    }
    if (!settings.enabled) { $('#rpg-vit-btn').hide(); return; }
    $('#rpg-vit-btn').show();
    $('#rpg-vit-btn').off('click').on('click', () => { _builtSig = null; renderPanel(); $('#rpg-vit-modal').toggleClass('visible'); });
}
function makeModalDraggable(elmnt, handle) {
    if (!handle) return;
    handle.onmousedown = (e) => {
        if (e.target.closest('.rpg-modal-close, .vex-close, button, input, select, .vex-b-del, .rpg-vit-e-del')) return;
        e.preventDefault();

        /* Remember how far the pointer is from the window's corner and keep that
           distance for the whole drag. transform is deliberately left alone — the
           opening animation and the fit-to-width scaling both use it, and writing
           there as well makes them fight and the window drift.

           Layout is measured once here, never during the drag, and the writes are
           batched into a single animation frame. */
        const rect = elmnt.getBoundingClientRect();
        const shiftX = e.clientX - rect.left;
        const shiftY = e.clientY - rect.top;

        let x = rect.left, y = rect.top, queued = false;

        const paint = () => {
            queued = false;
            elmnt.style.left = x + 'px';
            elmnt.style.top = y + 'px';
        };

        elmnt.style.left = rect.left + 'px';
        elmnt.style.top = rect.top + 'px';

        const onMove = (ev) => {
            ev.preventDefault();
            x = ev.clientX - shiftX;
            y = ev.clientY - shiftY;
            if (!queued) { queued = true; requestAnimationFrame(paint); }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            paint();
        };

        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
    };
}

// Dispatcher: full rebuild only when the panel's STRUCTURE changes; otherwise repaint values in
// place so routine stat updates don't tear down the DOM (which caused the panel to "jump"/flicker
// and restarted the ECG/pulse animations every time).
/* Every action rebuilds the panel, and the panel scrolls — both the body and the
   list of effects. Nothing remembered where they were, so changing one number threw
   you back to the top. Taken before a redraw, put back after. */
const VIT_SCROLL = ['.rpg-vit-body', '.vex-efflist'];

function grabVitScroll() {
    const out = [];
    try {
        const root = document.getElementById('rpg-vit-modal');
        if (!root) return out;
        VIT_SCROLL.forEach(sel => {
            root.querySelectorAll(sel).forEach((el, i) => {
                if (el.scrollTop > 0) out.push({ sel, i, top: el.scrollTop });
            });
        });
    } catch (e) { /* never let this break a redraw */ }
    return out;
}

function restoreVitScroll(saved) {
    if (!saved || !saved.length) return;
    try {
        const root = document.getElementById('rpg-vit-modal');
        if (!root) return;
        saved.forEach(sv => {
            const el = root.querySelectorAll(sv.sel)[sv.i];
            if (el) el.scrollTop = sv.top;      // a shorter list is clamped by the browser
        });
    } catch (e) { /* same */ }
}

/* ============================================================
   THE ANGEL
   ------------------------------------------------------------
   When HP reaches zero the chat does not simply end. An angel turns up — tsundere,
   of no fixed gender, faintly annoyed at having to be here — and asks five questions
   about the world the character lives in. Two wrong answers are forgiven. Three are
   not.

   Win, and you are sent back with twenty health and a blessing. Lose, and you get a
   card with your name on it and the offer of a new chat. The old chat is never
   deleted: it is still there to go back to.

   Once per chat. Death should cost something.
   ============================================================ */

const ANGEL_KEY = 'RPG_VITALS_ANGEL';

/* The angel is generated per trial, so it is a different one each time — but the
   personality is picked from a fixed set rather than left to chance in the prompt,
   because "tsundere" alone produces the same sulky angel every time. */
const ANGEL_MOODS = [
    { id: 'irritated', en: 'openly irritated at having been called down for this', ru: 'откровенно раздражён тем, что его вызвали ради этого' },
    { id: 'bored', en: 'bored, treating the whole thing as paperwork', ru: 'скучающий, относится к делу как к бумажной работе' },
    { id: 'fond', en: 'secretly fond of the mortal and furious about being secretly fond', ru: 'втайне привязан к смертному и в бешенстве от собственной привязанности' },
    { id: 'strict', en: 'strict and formal, hiding concern behind procedure', ru: 'строгий и официальный, прячет заботу за процедурой' },
    { id: 'smug', en: 'smug, enjoying watching a mortal squirm', ru: 'самодовольный, наслаждается тем, как смертный выкручивается' }
];

const ANGEL_PROMPT = `You are writing a short trial scene for a roleplay game. The player's character has just died, and an angel has come to decide whether to send them back.

THE ANGEL
Gender: {gender}. Personality: tsundere — sharp on the surface, unwilling to admit any warmth, and {mood}. Give the angel a name that fits the setting below.

THE TRIAL
Write FIVE multiple-choice questions about THE WORLD the character lives in — its era, its customs, how ordinary things work in it, what people of that time and place would take for granted. Read the scene and the card below and pitch the questions at that world specifically. If the setting is historical, ask about that century. If it is invented, ask about what the card and the story establish.

Questions must be answerable by someone paying attention to this story and this world. Not trivia about our world unless the story is set in it. Not questions about the plot of this chat.

Each question: four options, exactly one correct. The wrong options must be plausible — a person who half-knows the setting should hesitate.

Return ONLY JSON, no prose, no markdown:
{"angel":{"name":"","greeting":"","onWin":"","onLose":""},"questions":[{"q":"","options":["","","",""],"answer":0,"note":""}]}

- greeting: two or three sentences, in character. The angel explains the terms — five questions, two mistakes forgiven — while making clear this is beneath them.
- onWin: two or three sentences. Grudging. They send the mortal back and refuse to be thanked, but a warning slips through.
- onLose: two or three sentences. Not cruel. Even this angel finds no pleasure in it.
- note: one sentence explaining the right answer, shown after the player answers.
- answer: the index of the correct option, 0 to 3.

Write everything in {lang}.

THE SCENE:
{scene}

THE CHARACTER CARD:
{card}`;

/* If the model cannot be reached the angel used to simply not come, leaving the card
   stuck on screen and the player dead with no way out. There is a trial waiting
   instead — written by hand, about nothing in particular, so it works in any setting
   and any century. Riddles rather than lore, because lore needs a model to read the
   card. */
const ANGEL_FALLBACK = {
    en: {
        name: 'The Angel on Duty',
        greeting: "Don't look so pleased with yourself. The records are down, so you get my questions instead of yours — riddles, since apparently that is what I am reduced to. Five of them. Miss three and I stop being nice.",
        onWin: "Fine. FINE. You may go back. Don't read anything into it, I simply cannot be bothered with the paperwork. And do try to be less breakable.",
        onLose: "No. I am sorry — and I do mean that, which is the irritating part. Rest now.",
        questions: [
            { q: 'What has to be broken before you can use it?', options: ['A promise', 'An egg', 'A window', 'A silence'], answer: 1, note: 'An egg — broken to be of any use at all.' },
            { q: 'The more you take of it, the more you leave behind. What is it?', options: ['Time', 'Breath', 'Footsteps', 'Water'], answer: 2, note: 'Footsteps: each one taken is one left behind you.' },
            { q: 'What can travel the world while staying in one corner?', options: ['A shadow', 'A stamp', 'A rumour', 'The moon'], answer: 1, note: 'A stamp — it crosses the world from the corner of an envelope.' },
            { q: 'What gets wetter the more it dries?', options: ['A river', 'A towel', 'A cloud', 'A stone'], answer: 1, note: 'A towel: drying something soaks it further.' },
            { q: 'What belongs to you, but is used far more by everyone else?', options: ['Your name', 'Your hands', 'Your house', 'Your patience'], answer: 0, note: 'Your name — spoken by others far more than by you.' },
            { q: 'What has many keys but cannot open a single lock?', options: ['A gaoler', 'A piano', 'A map', 'A riddle'], answer: 1, note: 'A piano.' },
            { q: 'What goes up but never comes down?', options: ['Smoke', 'A price', 'Your age', 'A prayer'], answer: 2, note: 'Your age — it only ever climbs.' }
        ]
    },
    ru: {
        name: 'Дежурный ангел',
        greeting: 'Не смотри так довольно. Записи недоступны, так что получишь мои вопросы вместо своих — загадки, раз уж до этого дошло. Пять штук. Ошибёшься трижды — и я перестану быть любезен.',
        onWin: 'Ладно. ЛАДНО. Можешь возвращаться. Не выдумывай себе ничего, просто мне лень возиться с бумагами. И постарайся быть менее хрупким.',
        onLose: 'Нет. Мне жаль — и это правда, что раздражает больше всего. Отдыхай.',
        questions: [
            { q: 'Что нужно сломать, прежде чем использовать?', options: ['Обещание', 'Яйцо', 'Окно', 'Тишину'], answer: 1, note: 'Яйцо — иначе от него никакого проку.' },
            { q: 'Чем больше берёшь, тем больше остаётся позади. Что это?', options: ['Время', 'Дыхание', 'Шаги', 'Вода'], answer: 2, note: 'Шаги: каждый сделанный остаётся за спиной.' },
            { q: 'Что объедет весь свет, оставаясь в одном углу?', options: ['Тень', 'Марка', 'Слух', 'Луна'], answer: 1, note: 'Марка — пересекает мир из угла конверта.' },
            { q: 'Что становится мокрее, чем больше сушит?', options: ['Река', 'Полотенце', 'Облако', 'Камень'], answer: 1, note: 'Полотенце: вытирая, само намокает.' },
            { q: 'Что принадлежит тебе, но другие пользуются им чаще?', options: ['Твоё имя', 'Твои руки', 'Твой дом', 'Твоё терпение'], answer: 0, note: 'Имя — его произносят другие куда чаще, чем ты сам.' },
            { q: 'У чего много ключей, но не открыть ни одного замка?', options: ['У тюремщика', 'У рояля', 'У карты', 'У загадки'], answer: 1, note: 'У рояля.' },
            { q: 'Что растёт, но никогда не убывает?', options: ['Дым', 'Цена', 'Возраст', 'Молитва'], answer: 2, note: 'Возраст — он только прибавляется.' }
        ]
    }
};

/* Five of the seven, in a different order each time, so a second death in a later chat
   is not the same five questions in the same order. */
function angelFallbackTrial() {
    const src = ANGEL_FALLBACK[settings.language === 'ru' ? 'ru' : 'en'];
    const pool = src.questions.slice();
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, 5).map(q => {
        // The options are shuffled too, and the answer index follows them.
        const right = q.options[q.answer];
        const opts = q.options.slice();
        for (let i = opts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [opts[i], opts[j]] = [opts[j], opts[i]];
        }
        return { q: q.q, options: opts, answer: opts.indexOf(right), note: q.note };
    });
    return {
        name: src.name, greeting: src.greeting, onWin: src.onWin, onLose: src.onLose,
        questions: picked, allowed: 2
    };
}

let angelState = null;      // { data, idx, wrong, answered } while a trial is running

function angelUsedKey() { return 'angelUsed'; }

function angelAvailable() {
    if (!settings.angelEnabled) return false;
    if (!state) return false;
    if (state[angelUsedKey()]) return false;    // one per chat
    return true;
}

/* Called whenever HP changes. Deliberately not tied to any one path — damage from a
   message, from the panel, from another extension all end up here. */
function angelCheckDeath() {
    if (!settings.angelEnabled || !state) return;
    if ((state.hp | 0) > 0) return;
    if (angelState) return;                      // already on screen

    /* The second death in the same chat. The angel came once and does not come twice —
       but doing nothing at all left the player at zero health with no card, no
       explanation and nothing to press. The plain notice is shown instead: the same
       two ways on, without a trial. */
    if (state[angelUsedKey()]) { angelState = { done: 'again' }; angelRender(); return; }
    angelBegin();
}

function angelSceneText() {
    try {
        const chat = getContext().chat || [];
        // How far back the angel reads. A long chat must not be sent wholesale, and
        // six messages is enough to know what room everyone is standing in.
        const depth = Math.max(2, Math.min(30, settings.angelDepth || 6));
        return chat.slice(-depth).filter(m => m && !m.is_system)
            .map(m => `${m.name || ''}: ${String(m.mes || '').replace(/\s+/g, ' ').trim()}`)
            .join('\n').slice(0, 2500);
    } catch (e) { return ''; }
}

function angelCardText() {
    try {
        const ctx = getContext();
        const ch = ctx.characters?.[ctx.characterId];
        if (!ch) return '';
        return [ch.name, ch.description, ch.personality, ch.scenario]
            .filter(Boolean).join('\n').slice(0, 2000);
    } catch (e) { return ''; }
}

async function angelBegin() {
    const myChat = getContext().chatId;
    angelState = { data: null, idx: 0, wrong: 0, answered: false, loading: true };
    angelRender();

    const ru = settings.language === 'ru';
    const mood = ANGEL_MOODS[Math.floor(Math.random() * ANGEL_MOODS.length)];
    const gender = Math.random() < 0.5 ? (ru ? 'мужской' : 'male') : (ru ? 'женский' : 'female');

    const sys = ANGEL_PROMPT
        .replace('{gender}', gender)
        .replace('{mood}', ru ? mood.ru : mood.en)
        .replace('{lang}', ru ? 'Russian' : 'English')
        .replace('{scene}', angelSceneText() || '(no scene)')
        .replace('{card}', angelCardText() || '(no card)');

    try {
        const out = await callAI(sys, ru ? 'Составь испытание.' : 'Write the trial.');
        if (!ownsChat(myChat)) { angelState = null; return; }
        const data = angelSanitize(out);
        if (!data) throw new Error('unusable answer');
        angelState = { data, idx: 0, wrong: 0, answered: false, loading: false };
    } catch (e) {
        console.error('[RPG Vitals] angel trial failed, using the written one:', e);
        if (!ownsChat(myChat)) { angelState = null; return; }
        // The trial still happens. Dying because an endpoint was unreachable would be
        // absurd, and so would leaving the card frozen on screen.
        angelState = { data: angelFallbackTrial(), idx: 0, wrong: 0, answered: false, loading: false };
        toastr.info(t('angel_offline'));
    }
    angelRender();
}

/* Nothing from the model is trusted: a trial with four identical options or an answer
   index pointing nowhere is worse than no trial at all. */
function angelSanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw.angel || {};
    const qs = Array.isArray(raw.questions) ? raw.questions : null;
    if (!qs) return null;

    const clean = [];
    for (const q of qs) {
        if (!q || typeof q.q !== 'string' || !q.q.trim()) continue;
        const opts = Array.isArray(q.options) ? q.options.map(o => String(o ?? '').trim()).filter(Boolean) : [];
        if (opts.length < 2) continue;
        if (new Set(opts).size !== opts.length) continue;      // duplicate options
        let ans = Number(q.answer);
        if (!Number.isInteger(ans) || ans < 0 || ans >= opts.length) continue;
        clean.push({ q: q.q.trim(), options: opts, answer: ans, note: String(q.note ?? '').trim() });
        if (clean.length === 5) break;
    }
    if (clean.length < 3) return null;      // fewer than three is not a trial

    return {
        name: String(a.name ?? '').trim() || (settings.language === 'ru' ? 'Ангел' : 'The Angel'),
        greeting: String(a.greeting ?? '').trim(),
        onWin: String(a.onWin ?? '').trim(),
        onLose: String(a.onLose ?? '').trim(),
        questions: clean,
        allowed: Math.max(1, clean.length - 3)   // five questions -> two mistakes forgiven
    };
}

function angelAnswer(i) {
    const st = angelState;
    // Already answered, or the card is between questions: a second click must not
    // count as a second answer.
    if (!st || !st.data || st.answered || st.busy) return;
    const q = st.data.questions[st.idx];
    st.answered = true;
    st.lastRight = (i === q.answer);
    st.picked = i;
    if (!st.lastRight) st.wrong++;
    angelRender();
}

function angelNext() {
    const st = angelState;
    if (!st || !st.data || st.busy) return;
    st.busy = true;
    if (st.wrong > st.data.allowed) return angelLose();
    st.idx++;
    if (st.idx >= st.data.questions.length) return angelWin();
    st.answered = false; st.picked = -1; st.busy = false;
    angelRender();
}

function angelWin() {
    const st = angelState;
    const d = st && st.data;
    state[angelUsedKey()] = true;

    /* setHp and addBuff each save, redraw and rebuild the injection on their own, so
       calling both and then saving again did all three work three times over. The
       state is set directly and written once. */
    state.hp = Math.min(20, state.maxHp || 100);
    clampHp();
    if (!Array.isArray(state.buffs)) state.buffs = [];
    state.buffs.push({
        name: t('angel_buff_name'),
        effect: t('angel_buff_eff'),
        kind: 'buff',
        duration: 10
    });
    saveState();
    buildInjection();

    // The chat is told what happened, in the angel's own words, so the model can
    // carry on from it instead of being surprised by a suddenly living character.
    angelSay(`[${t('angel_chat_win', { name: d ? d.name : '' })}${d && d.onWin ? '\n' + d.onWin : ''}]`);

    angelState = { done: 'win', data: d };
    angelRender();
    renderPanel();
}

function angelLose() {
    const st = angelState;
    state[angelUsedKey()] = true;
    /* Health is left at zero deliberately — the character is dead, and the card says
       so. But the trial is spent, so nothing will call the angel again: without this
       the player would sit at zero with every later message quietly trying and failing
       to summon someone. The panel now shows the state plainly and the two buttons are
       the only way on. */
    saveState();
    buildInjection();
    angelState = { done: 'lose', data: st && st.data };
    angelRender();
    renderPanel();
}

function angelSay(text) {
    try {
        const ctx = getContext();
        const chat = ctx.chat;
        if (!chat) return;
        chat.push({
            name: 'System', is_user: false, is_system: false, is_name: false,
            send_date: Date.now(), mes: text, extra: { rpg_vitals_angel: true }
        });
        if (typeof ctx.addOneMessage === 'function') ctx.addOneMessage(chat[chat.length - 1]);
        saveChatDebounced();
    } catch (e) { console.error('[RPG Vitals] angel message failed:', e); }
}

async function angelNewChat() {
    try {
        const ctx = getContext();
        // The old chat is NOT deleted — a new one is opened beside it, so the story
        // can still be read or picked up again.
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            await ctx.executeSlashCommandsWithOptions('/newchat');
        } else if (typeof ctx.executeSlashCommands === 'function') {
            await ctx.executeSlashCommands('/newchat');
        } else {
            toastr.info(t('angel_newchat_manual'));
        }
    } catch (e) {
        console.error('[RPG Vitals] new chat failed:', e);
        toastr.info(t('angel_newchat_manual'));
    }
    angelClose();
}

function angelClose() {
    angelState = null;
    const el = document.getElementById('rpg-angel');
    if (el) el.remove();
}

/* ---------- the card itself ---------- */
/* The card is rebuilt on every click — answering, moving to the next question — and
   its entrance animations replayed each time, which reads as a flinch. The flag goes
   on after the first draw and stays: taking it off again is what makes an animation
   start, not what stops it. */
let angelDrawn = false;

function angelRender() {
    let el = document.getElementById('rpg-angel');
    if (!angelState) { if (el) el.remove(); angelDrawn = false; return; }

    if (!el) {
        el = document.createElement('div');
        el.id = 'rpg-angel';
        document.body.appendChild(el);
        angelDrawn = false;                      // a fresh card may make its entrance
    }
    el.classList.toggle('ang-quiet', angelDrawn);
    angelDrawn = true;

    const st = angelState;
    const d = st.data;

    if (st.loading) {
        el.innerHTML = `<div class="ang-dim"></div>
            <div class="ang-card ang-wait"><div class="ang-title">${escapeHtml(t('angel_dead'))}</div>
            <div class="ang-sub">${escapeHtml(t('angel_waiting'))}</div></div>`;
        return;
    }

    if (st.done === 'win') {
        el.innerHTML = `<div class="ang-dim"></div>
            <div class="ang-card ang-good">
                <div class="ang-name">${escapeHtml(d ? d.name : '')}</div>
                <div class="ang-speech">${escapeHtml(d && d.onWin ? d.onWin : '')}</div>
                <div class="ang-verdict">${escapeHtml(t('angel_spared'))}</div>
                <div class="ang-actions"><button class="ang-btn ok" data-ang="close">${escapeHtml(t('angel_back'))}</button></div>
            </div>`;
        angelWire(el);
        return;
    }

    if (st.done === 'again') {
        el.innerHTML = `<div class="ang-dim"></div>
            <div class="ang-card">
                <div class="ang-title ang-bleed">${escapeHtml(t('angel_dead'))}</div>
                <div class="ang-speech">${escapeHtml(t('angel_again'))}</div>
                <div class="ang-actions">
                    <button class="ang-btn" data-ang="close">${escapeHtml(t('angel_stay'))}</button>
                    <button class="ang-btn danger" data-ang="new">${escapeHtml(t('angel_restart'))}</button>
                </div>
                <div class="ang-note">${escapeHtml(t('angel_kept'))}</div>
            </div>`;
        angelWire(el);
        return;
    }

    if (st.done === 'lose') {
        el.innerHTML = `<div class="ang-dim"></div>
            <div class="ang-card">
                <div class="ang-title ang-bleed">${escapeHtml(t('angel_dead'))}</div>
                <div class="ang-name">${escapeHtml(d ? d.name : '')}</div>
                <div class="ang-speech">${escapeHtml(d && d.onLose ? d.onLose : '')}</div>
                <div class="ang-actions">
                    <button class="ang-btn" data-ang="close">${escapeHtml(t('angel_stay'))}</button>
                    <button class="ang-btn danger" data-ang="new">${escapeHtml(t('angel_restart'))}</button>
                </div>
                <div class="ang-note">${escapeHtml(t('angel_kept'))}</div>
            </div>`;
        angelWire(el);
        return;
    }

    const q = d.questions[st.idx];
    const left = d.allowed - st.wrong;
    const opts = q.options.map((o, i) => {
        let cls = '';
        if (st.answered) {
            if (i === q.answer) cls = 'right';
            else if (i === st.picked) cls = 'wrong';
        }
        return `<button class="ang-opt ${cls}" data-ang="pick" data-i="${i}" ${st.answered ? 'disabled' : ''}>${escapeHtml(o)}</button>`;
    }).join('');

    el.innerHTML = `<div class="ang-dim"></div>
        <div class="ang-card">
            <div class="ang-title ang-bleed">${escapeHtml(t('angel_dead'))}</div>
            <div class="ang-name">${escapeHtml(d.name)}</div>
            ${st.idx === 0 && d.greeting ? `<div class="ang-speech">${escapeHtml(d.greeting)}</div>` : ''}
            <div class="ang-meta">
                <span>${escapeHtml(t('angel_q', { n: st.idx + 1, of: d.questions.length }))}</span>
                <span class="ang-lives ${left <= 0 ? 'last' : ''}">${escapeHtml(t('angel_left', { n: Math.max(0, left) }))}</span>
            </div>
            <div class="ang-q">${escapeHtml(q.q)}</div>
            <div class="ang-opts">${opts}</div>
            ${st.answered ? `<div class="ang-note ${st.lastRight ? 'ok' : 'bad'}">${escapeHtml(q.note || '')}</div>
                <div class="ang-actions"><button class="ang-btn ok" data-ang="next">${escapeHtml(
                    st.wrong > d.allowed ? t('angel_verdict') : (st.idx + 1 >= d.questions.length ? t('angel_verdict') : t('angel_next')))}</button></div>` : ''}
        </div>`;
    angelWire(el);
}

function angelWire(el) {
    el.querySelectorAll('[data-ang]').forEach(b => {
        b.addEventListener('click', () => {
            const what = b.dataset.ang;
            if (what === 'pick') angelAnswer(parseInt(b.dataset.i, 10));
            else if (what === 'next') angelNext();
            else if (what === 'new') angelNewChat();
            else angelClose();
        });
    });
}

function renderPanel() {
    const bodyEl = document.getElementById('rpg-vit-body');
    if (!bodyEl || !state) return;
    const sig = structSig();
    if (sig === _builtSig && bodyEl.querySelector('.vex')) {
        try { paintPanel(); return; } catch (e) { _builtSig = null; /* fall back to a full rebuild */ }
    }
    _builtSig = sig;
    buildPanel();
}

// What makes the DOM shape change (as opposed to just values). Kept deliberately broad: if in doubt
// it differs, we simply rebuild (the old, safe behaviour) — we never risk showing stale content.
function structSig() {
    if (!state) return 'none';
    const flat = (state.hp / (state.maxHp || 100)) <= 0;
    const buffs = state.buffs.map(b => `${b.id}:${b.kind === 'debuff' ? 'd' : 'b'}:${b.duration == null ? 'x' : 'n'}:${b.effect ? 'e' : ''}`).join(',');
    const enemies = state.enemies.map(e => `${e.id}:${e.hp}/${e.max}`).join(',');   // grouped rows aggregate hp — any change rebuilds
    return [
        settings.language, !!settings.gmControls, !!settings.hungerEnabled, !!settings.manaEnabled,
        !!settings.fatigueEnabled, !!settings.levelEnabled, flat,
        state.buffs.length === 0 ? 'empty' : 'has', buffs,
        (settings.gmControls || state.enemies.length) ? 'combat' : 'nocombat', enemies
    ].join('|');
}

function paintCells(container, val) {
    if (!container) return;
    const filled = Math.max(0, Math.min(10, Math.round((val || 0) / 10)));
    container.querySelectorAll('i').forEach((c, i) => c.classList.toggle('on', i < filled));
}
function syncGmInputs(body) {
    if (!settings.gmControls) return;
    const pairs = [['.rpg-vit-set-hp', state.hp], ['.rpg-vit-set-max', state.maxHp], ['.rpg-vit-mana-set', state.mana], ['.rpg-vit-fat-set', state.fatigue]];
    for (const [sel, val] of pairs) {
        const el = body.querySelector(sel);
        if (el && el !== document.activeElement) el.value = val;
    }
}
// In-place value update — no DOM teardown, so animations keep running and bars transition smoothly.
function paintPanel() {
    const body = document.getElementById('rpg-vit-body');
    if (!body || !state) return;
    const hpc = hpColor();
    const hpv = body.querySelector('.js-hp-v'); if (hpv) hpv.textContent = `${state.hp} / ${state.maxHp}`;
    const live = body.querySelector('.vex-ecg .live'); if (live) live.style.stroke = hpc;
    const blip = body.querySelector('.vex-blip'); if (blip) blip.style.background = hpc;
    if (settings.hungerEnabled) {
        const sv = body.querySelector('.js-sat-v'); if (sv) sv.textContent = `${state.hunger} / 100`;
        paintCells(body.querySelector('.js-sat-cells'), state.hunger);
    }
    if (settings.manaEnabled) {
        const mv = body.querySelector('.js-mana-v'); if (mv) mv.textContent = `${state.mana} / 100`;
        paintCells(body.querySelector('.js-mana-cells'), state.mana);
    }
    if (settings.fatigueEnabled) {
        const fv = body.querySelector('.js-fat-v'); if (fv) fv.textContent = `${state.fatigue} / 100`;
        paintCells(body.querySelector('.js-fat-cells'), state.fatigue);
    }
    if (settings.levelEnabled) {
        const ln = body.querySelector('.vex-lvl-n'); if (ln) ln.textContent = `${t('level_word')} ${state.level}`;
        const lf = body.querySelector('.vex-lvl-fill'); if (lf) lf.style.width = (state.level >= MAX_LEVEL ? 100 : state.xp) + '%';
        const lc = body.querySelector('.vex-lvl'); if (lc) lc.setAttribute('title', `${state.xp}/${XP_PER_LEVEL} ${t('xp')}`);
    }
    for (const b of state.buffs) {
        if (b.duration != null) {
            const d = body.querySelector(`.vex-s[data-bid="${b.id}"] .vex-dur`); if (d) d.textContent = b.duration;
        }
        const efd = body.querySelector(`.vex-efl[data-bid="${b.id}"] .vex-efl-d`);
        if (efd) efd.textContent = (b.duration == null ? t('forever') : b.duration);
    }
    for (const e of state.enemies) {
        const row = body.querySelector(`.vex-enemy[data-eid="${e.id}"]`); if (!row) continue;
        const num = row.querySelector('.js-e-hp');
        if (num) num.textContent = `${e.hp}/${e.max}${e.atk ? ` · ${t('enemy_atk_ph')} ${e.atk}` : ''}`;
        const bar = row.querySelector('.rpg-vit-bar');
        if (bar) bar.style.width = Math.max(0, Math.min(100, Math.round(e.hp / (e.max || 1) * 100))) + '%';
    }
    syncGmInputs(body);
}

function buildPanel() {
    const body = $('#rpg-vit-body');
    if (body.length === 0 || !state) return;
    const pct = Math.max(0, Math.min(100, Math.round((state.hp / (state.maxHp || 100)) * 100)));
    const gm = !!settings.gmControls;
    const hpc = hpColor();

    const PULSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>';
    const HEART = '<svg viewBox="0 0 24 24" fill="var(--oxblood)" stroke="none"><path d="M12 21s-7-4.6-9.3-9C1 8.6 2.7 5 6 5c2 0 3.2 1.1 4 2.3C10.8 6.1 12 5 14 5c3.3 0 5 3.6 3.3 7C19 16.4 12 21 12 21Z"/></svg>';
    const FOOD = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--food-deep)" stroke-width="1.8"><path d="M5 2v8a2 2 0 0 0 2 2v10M7 2v6M9 2v6M9 2v8a2 2 0 0 1-2 2M16 2c-1.5 0-2.5 2-2.5 5s1 4 2.5 4v11"/></svg>';
    const UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
    const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 5v14M5 12h14"/></svg>';
    const MANA = '<svg viewBox="0 0 24 24" fill="none" stroke="#2f5d7c" stroke-width="1.8"><path d="M12 2s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12Z"/></svg>';
    const FATIGUE = '<svg viewBox="0 0 24 24" fill="none" stroke="#8a6a16" stroke-width="1.8"><path d="M4 18h6l-6 3h8M13 4h7l-7 6h7"/></svg>';

    // HP ECG
    const flat = pct <= 0;
    const ecgPath = flat
        ? 'M0 23 H300'
        : 'M0 23 H56 L62 23 L67 9 L72 38 L77 14 L82 23 H120 L126 23 L131 9 L136 38 L141 14 L146 23 H200 L206 23 L211 9 L216 38 L221 14 L226 23 H300';
    const ecg = `<div class="vex-ecg">
        <svg viewBox="0 0 300 46" preserveAspectRatio="none">
            <path class="base" d="${ecgPath}"/>
            <!-- No pathLength: it made the dash animation measure the trace evenly,
                 while the dot travels by true distance along the same path. The spikes
                 make the real path about sixty percent longer than its width, so the
                 two agreed on the flat parts and separated on every peak. -->
            <path class="live" style="stroke:${hpc};" d="${ecgPath}"/>
            ${flat ? '' : `<path class="blip" style="stroke:${hpc};" d="${ecgPath}"/>`}
        </svg>
    </div>`;

    // satiety ration cells
    const filled = Math.max(0, Math.min(10, Math.round((state.hunger || 0) / 10)));
    const cells = Array.from({ length: 10 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');

    // mana / fatigue ration cells
    const manaFilled = Math.max(0, Math.min(10, Math.round((state.mana || 0) / 10)));
    const manaCells = Array.from({ length: 10 }, (_, i) => `<i class="${i < manaFilled ? 'on' : ''}"></i>`).join('');
    const fatFilled = Math.max(0, Math.min(10, Math.round((state.fatigue || 0) / 10)));
    const fatCells = Array.from({ length: 10 }, (_, i) => `<i class="${i < fatFilled ? 'on' : ''}"></i>`).join('');

    const manaCtrl = gm ? `<div class="vex-ctrl">
            <input type="number" class="text_pole rpg-vit-mana-set" value="${state.mana}" min="0" max="100">
            <button class="rpg-vit-btn rpg-vit-mana-btn"><i class="fa-solid fa-pen"></i> ${escapeHtml(t('set_setlbl'))}</button>
        </div>` : '';
    const fatCtrl = gm ? `<div class="vex-ctrl">
            <input type="number" class="text_pole rpg-vit-fat-set" value="${state.fatigue}" min="0" max="100">
            <button class="rpg-vit-btn rpg-vit-fat-btn"><i class="fa-solid fa-pen"></i> ${escapeHtml(t('set_setlbl'))}</button>
        </div>` : '';

    const levelChip = settings.levelEnabled ? `<div class="vex-lvl" title="${state.xp}/${XP_PER_LEVEL} ${escapeHtml(t('xp'))}">
            <span class="vex-lvl-n">${escapeHtml(t('level_word'))} ${state.level}</span>
            <div class="vex-lvl-bar"><div class="vex-lvl-fill" style="width:${state.level >= MAX_LEVEL ? 100 : state.xp}%;"></div></div>
        </div>` : '';

    // effects
    let slots, efflist = '';
    if (state.buffs.length === 0) {
        slots = `<div class="vex-clean">${escapeHtml(t('clean'))}</div>`
            + `<div class="vex-s">${PLUS}</div>`.repeat(3)
            + `<span class="vex-eff-note">${escapeHtml(t('no_effects'))}</span>`;
    } else {
        slots = state.buffs.map(b => {
            const deb = b.kind === 'debuff';
            return `<div class="vex-s filled ${deb ? 'debuff' : ''}" data-bid="${b.id}" title="${escapeHtml(b.name + (b.effect ? ' — ' + b.effect : ''))}">
                ${deb ? DOWN : UP}
                ${b.duration == null ? '' : `<span class="vex-dur">${b.duration}</span>`}
                ${gm ? `<span class="vex-b-del rpg-vit-b-del" data-id="${b.id}">✕</span>` : ''}
            </div>`;
        }).join('');
        efflist = `<div class="vex-efflist">` + state.buffs.map(b => `<div class="vex-efl ${b.kind === 'debuff' ? 'debuff' : ''}" data-bid="${b.id}">
            <span class="vex-efl-n">${escapeHtml(b.name)}</span>
            <span class="vex-efl-e">${b.effect ? escapeHtml(b.effect) : ''}</span>
            <span class="vex-efl-d">${b.duration == null ? escapeHtml(t('forever')) : b.duration}</span>
        </div>`).join('') + `</div>`;
    }

    const hpCtrl = gm ? `<div class="vex-ctrl">
            <input type="number" class="text_pole rpg-vit-amt" value="10" min="1">
            <button class="rpg-vit-btn ok rpg-vit-heal"><i class="fa-solid fa-plus"></i> ${escapeHtml(t('heal'))}</button>
            <button class="rpg-vit-btn danger rpg-vit-hurt"><i class="fa-solid fa-minus"></i> ${escapeHtml(t('hurt'))}</button>
        </div>
        <div class="vex-ctrl">
            <input type="number" class="text_pole rpg-vit-set-hp" value="${state.hp}" min="0" title="${escapeHtml(t('hp'))}">
            <input type="number" class="text_pole rpg-vit-set-max" value="${state.maxHp}" min="1" title="${escapeHtml(t('max'))}">
            <button class="rpg-vit-btn rpg-vit-setbtn"><i class="fa-solid fa-pen"></i> ${escapeHtml(t('set_hp'))}</button>
        </div>` : '';

    const hungerCtrl = gm ? `<div class="vex-ctrl">
            <input type="number" class="text_pole rpg-vit-h-amt" value="20" min="1">
            <button class="rpg-vit-btn ok rpg-vit-feed"><i class="fa-solid fa-drumstick-bite"></i> ${escapeHtml(t('feed'))}</button>
            <button class="rpg-vit-btn rpg-vit-h-set"><i class="fa-solid fa-pen"></i> ${escapeHtml(t('set_hungerlbl'))}</button>
        </div>` : '';

    const addEffect = gm ? `<div class="vex-add">
            <input type="text" class="text_pole rpg-vit-n-name" placeholder="${escapeHtml(t('name_ph'))}">
            <input type="text" class="text_pole rpg-vit-n-eff" placeholder="${escapeHtml(t('effect_ph'))}">
            <div class="vex-add-row">
                <select class="text_pole rpg-vit-n-kind" style="width:auto;"><option value="buff">${escapeHtml(t('buff'))}</option><option value="debuff">${escapeHtml(t('debuff'))}</option></select>
                <input type="number" class="text_pole rpg-vit-n-dur" placeholder="${escapeHtml(t('duration'))}" min="1" style="width:70px;">
                <button class="rpg-vit-btn ok rpg-vit-add-btn"><i class="fa-solid fa-plus"></i> ${escapeHtml(t('add_effect'))}</button>
            </div>
        </div>` : '';

    const combatBlock = (gm || state.enemies.length) ? `<div class="vex-section">${escapeHtml(t('combat'))}</div>
        ${state.enemies.length ? groupedEnemies().map(g => {
            const epct = Math.max(0, Math.min(100, Math.round(g.hp / (g.max || 1) * 100)));
            return `<div class="vex-enemy" data-eid="${g.repId}">
                <div class="rpg-vit-hp-top"><span class="rpg-vit-b-name">${escapeHtml(g.label)}</span><span class="rpg-vit-hp-num"><span class="js-e-hp">${g.hp}/${g.max}${g.atk ? ` · ${escapeHtml(t('enemy_atk_ph'))} ${g.atk}` : ''}</span> <i class="fa-solid fa-xmark rpg-vit-e-del" data-id="${g.repId}" title="${escapeHtml(t('remove'))}" style="cursor:pointer;color:var(--sepia);margin-left:6px;"></i></span></div>
                <div class="rpg-vit-bar-wrap"><div class="rpg-vit-bar" style="width:${epct}%; background:#b0432f;"></div></div>
                ${gm ? `<div class="vex-ctrl">
                    <button class="rpg-vit-btn ok rpg-vit-atk" data-id="${g.repId}"><i class="fa-solid fa-gavel"></i> ${escapeHtml(t('attack'))}</button>
                    <button class="rpg-vit-btn danger rpg-vit-ehit" data-id="${g.repId}"><i class="fa-solid fa-burst"></i> ${escapeHtml(t('enemy_hit'))}</button>
                </div>` : ''}
            </div>`;
        }).join('') : `<div class="vex-eff-note">${escapeHtml(t('no_enemies'))}</div>`}
        ${gm ? `<div class="vex-add"><div class="vex-add-row">
            <input type="text" class="text_pole rpg-vit-e-name" placeholder="${escapeHtml(t('enemy_name_ph'))}">
            <input type="number" class="text_pole rpg-vit-e-hp" placeholder="${escapeHtml(t('enemy_hp_ph'))}" min="1" style="width:60px;">
            <input type="number" class="text_pole rpg-vit-e-atk" placeholder="${escapeHtml(t('enemy_atk_ph'))}" min="0" style="width:60px;">
            <button class="rpg-vit-btn ok rpg-vit-e-add"><i class="fa-solid fa-plus"></i> ${escapeHtml(t('add_enemy'))}</button>
        </div></div>` : ''}` : '';

    const keepScroll = grabVitScroll();

    body.html(`<div class="vex-fit"><div class="vex${settings.gmControls ? ' gm' : ''}">
        <span class="vex-clip"></span>
        <div class="vex-hang"><span class="str"></span><div class="tag"><b>${escapeHtml(t('exam_b'))}</b><i>${escapeHtml(t('exam_i'))}</i></div></div>
        <div class="vex-head" id="vex-drag">
            <div class="vex-pulse">${PULSE}</div>
            <div class="vex-title"><h1>${escapeHtml(t('panel_title'))}</h1><div class="sub">${escapeHtml(t('vex_sub'))}</div></div>
            ${levelChip}
            <button class="vex-close" aria-label="${escapeHtml(t('close'))}">✕</button>
        </div>
        <div class="vex-cols">
        <div class="vex-col">
        <div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${HEART}<span class="vex-k">${escapeHtml(t('lbl_health'))}</span></div><span class="vex-v js-hp-v">${state.hp} / ${state.maxHp}</span></div>
            ${ecg}
            ${hpCtrl}
        </div>
        ${settings.hungerEnabled ? `<div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${FOOD}<span class="vex-k">${escapeHtml(t('lbl_satiety'))}</span></div><span class="vex-v js-sat-v">${state.hunger} / 100</span></div>
            <div class="vex-cells js-sat-cells">${cells}</div>
            ${hungerCtrl}
        </div>` : ''}
        ${settings.manaEnabled ? `<div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${MANA}<span class="vex-k">${escapeHtml(t('lbl_mana'))}</span></div><span class="vex-v js-mana-v">${state.mana} / 100</span></div>
            <div class="vex-cells mana js-mana-cells">${manaCells}</div>
            ${manaCtrl}
        </div>` : ''}
        ${settings.fatigueEnabled ? `<div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${FATIGUE}<span class="vex-k">${escapeHtml(t('lbl_fatigue'))}</span></div><span class="vex-v js-fat-v">${state.fatigue} / 100</span></div>
            <div class="vex-cells fatigue js-fat-cells">${fatCells}</div>
            ${fatCtrl}
        </div>` : ''}
        </div>
        <div class="vex-col">
        <div class="vex-eff">
            <div class="vex-eff-h">${escapeHtml(t('lbl_effects'))}</div>
            <div class="vex-slots">${slots}</div>
            ${efflist}
            ${addEffect}
        </div>
        ${combatBlock}
        </div>
        </div>
    </div></div>`);

    body.find('.vex-close').off('click').on('click', () => $('#rpg-vit-modal').removeClass('visible'));
    body.find('.rpg-vit-heal').off('click').on('click', () => heal(parseInt(body.find('.rpg-vit-amt').val()) || 0));
    body.find('.rpg-vit-feed').off('click').on('click', () => feed(parseInt(body.find('.rpg-vit-h-amt').val()) || 0));
    body.find('.rpg-vit-h-set').off('click').on('click', () => setHunger(parseInt(body.find('.rpg-vit-h-amt').val()) || 0));
    body.find('.rpg-vit-mana-btn').off('click').on('click', () => setMana(parseInt(body.find('.rpg-vit-mana-set').val()) || 0));
    body.find('.rpg-vit-fat-btn').off('click').on('click', () => setFatigue(parseInt(body.find('.rpg-vit-fat-set').val()) || 0));
    body.find('.rpg-vit-hurt').off('click').on('click', () => damage(parseInt(body.find('.rpg-vit-amt').val()) || 0));
    body.find('.rpg-vit-setbtn').off('click').on('click', () => setHp(parseInt(body.find('.rpg-vit-set-hp').val()), parseInt(body.find('.rpg-vit-set-max').val())));
    body.find('.rpg-vit-b-del').off('click').on('click', function () { removeBuff($(this).data('id')); });
    body.find('.rpg-vit-add-btn').off('click').on('click', function () {
        const name = body.find('.rpg-vit-n-name').val().trim();
        if (!name) { toastr.warning(t('toast_need_name')); return; }
        const dur = parseInt(body.find('.rpg-vit-n-dur').val());
        addBuff({ name, effect: body.find('.rpg-vit-n-eff').val().trim(), kind: body.find('.rpg-vit-n-kind').val(), duration: dur > 0 ? dur : null });
        toastr.success(t('toast_added'));
    });
    body.find('.rpg-vit-atk').off('click').on('click', function () { attackEnemy($(this).data('id')); });
    body.find('.rpg-vit-ehit').off('click').on('click', function () { enemyHitsYou($(this).data('id')); });
    body.find('.rpg-vit-e-del').off('click').on('click', function () {
        groupOf($(this).data('id')).forEach(e => removeEnemy(e.id));   // ✕ clears the whole stack
    });
    body.find('.rpg-vit-e-add').off('click').on('click', function () {
        const name = body.find('.rpg-vit-e-name').val().trim();
        if (!name) { toastr.warning(t('toast_need_ename')); return; }
        addEnemy(name, body.find('.rpg-vit-e-hp').val(), body.find('.rpg-vit-e-atk').val());
    });

    $('#rpg-vit-modal').toggleClass('vex-wide', !!settings.gmControls);
    fitCard();
    // After fitCard, because that is what settles the final heights — restoring before
    // it would be clamped against a layout that is about to change.
    restoreVitScroll(keepScroll);
    const dragEl = body.find('#vex-drag')[0];
    if (dragEl) makeModalDraggable(document.getElementById('rpg-vit-modal'), dragEl);
}

function fitCard() {
    const fit = document.querySelector('#rpg-vit-body .vex-fit');
    const card = document.querySelector('#rpg-vit-body .vex');
    if (!fit || !card) return;
    // Only downscale for narrow WIDTH (small screens). Never scale by height —
    // a tall card scrolls inside the panel instead of being squished.
    // Resetting the transform and the height first made the browser lay the card out
    // unscaled, and that intermediate state is painted — the panel jumps to full size
    // and back on every redraw. Measuring before anything is written keeps it to one
    // invisible change. getBoundingClientRect reports the SCALED size, so the previous
    // scale is divided back out to recover the natural one.
    const prev = fit.dataset.scale ? parseFloat(fit.dataset.scale) : 1;
    const cardRect = card.getBoundingClientRect();
    const cardW = (cardRect.width / (prev || 1)) || 372;
    const cardH = cardRect.height / (prev || 1);

    const availW = Math.min(cardW + 8, window.innerWidth * 0.96) - 4;
    const s = Math.min(1, availW / cardW);
    fit.style.transformOrigin = 'top center';
    fit.style.transform = 'scale(' + s + ')';
    fit.style.height = s < 1 ? (cardH * s + 30) + 'px' : 'auto';
    fit.dataset.scale = String(s);
}


// ---- settings ----
function settingsHtml() {
    return `
<div class="extension_settings rpg-vit-settings">
    <div class="inline-drawer">
        <div class="rpg-vit-toggle inline-drawer-header" style="cursor: pointer;">
            <b><i class="fa-solid fa-heart-pulse"></i> ${t('set_title')}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none; padding-top: 10px;">
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-enabled"> ${t('set_enable')}</label>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10" style="margin-top:8px;">
                <label>${t('set_lang')}</label>
                <select id="rpg-vit-lang" class="text_pole" style="width:auto;">
                    <option value="en">English</option>
                    <option value="ru">Русский</option>
                </select>
            </div>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10">
                <label>${t('set_maxhp')}</label>
                <input type="number" id="rpg-vit-maxhp" class="text_pole" min="1" style="width:64px;">
            </div>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10">
                <label>${t('set_depth')}</label>
                <input type="number" id="rpg-vit-depth" class="text_pole" min="0" style="width:55px;">
            </div>
            <hr style="border-color:#d8ccae;">
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-hunger-en"> ${t('set_hunger')}</label>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10" style="margin-top:6px;">
                <label>${t('set_hunger_every')}</label>
                <input type="number" id="rpg-vit-hunger-every" class="text_pole" min="1" style="width:55px;">
            </div>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10">
                <label>${t('set_hunger_amount')}</label>
                <input type="number" id="rpg-vit-hunger-amt" class="text_pole" min="1" style="width:55px;">
            </div>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10">
                <label>${t('set_starve_dmg')}</label>
                <input type="number" id="rpg-vit-starve-dmg" class="text_pole" min="0" style="width:55px;">
            </div>
            <hr style="border-color:#d8ccae;">
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-autoexpire"> ${t('set_autoexpire')}</label>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10" style="padding-left:22px;">
                <label>${t('set_autoexpire_max')}</label>
                <input type="number" id="rpg-vit-autoexpire-max" class="text_pole" min="1" max="200" style="width:55px;">
            </div>
            <hr style="border-color:#d8ccae;">
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-level-en"> ${t('set_level')}</label>
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-mana-en"> ${t('set_mana')}</label>
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-fatigue-en"> ${t('set_fatigue')}</label>
            <hr style="border-color:#d8ccae;">
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-gm"> ${t('set_gm')}</label>
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-angel"> ${t('angel_set')}</label>
            <div class="rpg-vit-note">${t('angel_hint')}</div>
            <label class="rpg-vit-row"><span>${t('angel_depth')}</span>
                <input type="number" id="rpg-vit-angel-depth" class="text_pole" min="2" max="30" step="1" style="width:70px;"></label>
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-autodetect"> ${t('set_autodetect')}</label>
            <hr style="border-color:#d8ccae;">
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-combat-inject"> ${t('set_combat_inject')}</label>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10" style="margin-top:6px;">
                <label>${t('set_combat_depth')}</label>
                <input type="number" id="rpg-vit-combat-depth" class="text_pole" min="0" style="width:55px;">
            </div>
            <label class="checkbox_label"><input type="checkbox" id="rpg-vit-combat-auto"> ${t('set_combat_auto')}</label>
            <div class="flex-container alignitemscenter flexgap5 margin-b-10" style="margin-top:6px;">
                <label>${t('set_combat_scan')}</label>
                <input type="number" id="rpg-vit-combat-scan" class="text_pole" min="1" max="10" style="width:55px;">
            </div>
            <div class="flex-container flexFlowColumn flexgap5" style="margin-top:6px;">
                <label>${t('set_url')}</label>
                <input type="text" id="rpg-vit-url" class="text_pole" placeholder="https://openrouter.ai/api/v1">
                <label>${t('set_key')}</label>
                <input type="password" id="rpg-vit-key" class="text_pole" placeholder="sk-...">
                <label>${t('set_model')}</label>
                <input type="text" id="rpg-vit-model" class="text_pole" placeholder="google/gemma-4-31b-it">
            </div>
        </div>
    </div>
</div>`;
}
function setupUI() {
    $('#extensions_settings').append(settingsHtml());
    $('.rpg-vit-settings .rpg-vit-toggle').on('click', function () {
        $(this).next('.inline-drawer-content').slideToggle();
        $(this).find('.inline-drawer-icon').toggleClass('down up');
    });
    $('#rpg-vit-enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = this.checked; saveSettings(); renderButton(); loadState(); buildInjection();
    });
    $('#rpg-vit-lang').val(settings.language || 'en').on('change', function () {
        settings.language = $(this).val(); saveSettings();
        $('.rpg-vit-settings').remove(); setupUI();
        $('.rpg-vit-settings .inline-drawer-content').show();
        $('.rpg-vit-settings .inline-drawer-icon').removeClass('down').addClass('up');
        $('#rpg-vit-btn').attr('title', t('btn_title')); $('#rpg-vit-title').text(t('panel_title'));
        renderPanel(); buildInjection();
    });
    $('#rpg-vit-maxhp').val(settings.defaultMaxHp).on('change', function () { settings.defaultMaxHp = Math.max(1, parseInt($(this).val()) || 100); saveSettings(); });
    $('#rpg-vit-depth').val(settings.injectDepth).on('change', function () { settings.injectDepth = Math.max(0, parseInt($(this).val()) || 0); $(this).val(settings.injectDepth); saveSettings(); buildInjection(); });
    $('#rpg-vit-hunger-en').prop('checked', !!settings.hungerEnabled).on('change', function () { settings.hungerEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-hunger-every').val(settings.hungerDrainEvery).on('change', function () { settings.hungerDrainEvery = Math.max(1, parseInt($(this).val()) || 3); saveSettings(); });
    $('#rpg-vit-hunger-amt').val(settings.hungerDrainAmount).on('change', function () { settings.hungerDrainAmount = Math.max(1, parseInt($(this).val()) || 5); saveSettings(); });
    $('#rpg-vit-starve-dmg').val(settings.starveDamage).on('change', function () { settings.starveDamage = Math.max(0, parseInt($(this).val()) || 0); saveSettings(); });
    $('#rpg-vit-autoexpire').prop('checked', !!settings.autoExpire).on('change', function () { settings.autoExpire = this.checked; saveSettings(); });
    $('#rpg-vit-autoexpire-max').val(settings.autoExpireMax).on('change', function () { settings.autoExpireMax = Math.max(1, parseInt($(this).val()) || 20); saveSettings(); });
    $('#rpg-vit-gm').prop('checked', !!settings.gmControls).on('change', function () { settings.gmControls = this.checked; saveSettings(); renderPanel(); });
    $('#rpg-vit-level-en').prop('checked', !!settings.levelEnabled).on('change', function () { settings.levelEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-mana-en').prop('checked', !!settings.manaEnabled).on('change', function () { settings.manaEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-fatigue-en').prop('checked', !!settings.fatigueEnabled).on('change', function () { settings.fatigueEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-angel').prop('checked', !!settings.angelEnabled).on('change', function () { settings.angelEnabled = this.checked; saveSettings(); });
    $('#rpg-vit-angel-depth').val(settings.angelDepth || 6).on('change', function () {
        settings.angelDepth = Math.max(2, Math.min(30, parseInt(this.value, 10) || 6));
        this.value = settings.angelDepth; saveSettings();
    });
    $('#rpg-vit-autodetect').prop('checked', !!settings.autoDetect).on('change', function () { settings.autoDetect = this.checked; saveSettings(); });
    $('#rpg-vit-combat-inject').prop('checked', settings.combatInject !== false).on('change', function () { settings.combatInject = this.checked; saveSettings(); buildInjection(); });
    $('#rpg-vit-combat-depth').val(typeof settings.combatDepth === 'number' ? settings.combatDepth : settings.injectDepth).on('change', function () { settings.combatDepth = Math.max(0, parseInt($(this).val()) || 0); saveSettings(); buildInjection(); });
    $('#rpg-vit-combat-auto').prop('checked', !!settings.combatAuto).on('change', function () { settings.combatAuto = this.checked; saveSettings(); });
    $('#rpg-vit-combat-scan').val(Math.max(1, Math.min(10, settings.combatScanMsgs || 4))).on('change', function () { settings.combatScanMsgs = Math.max(1, Math.min(10, parseInt($(this).val()) || 4)); saveSettings(); });
    $('#rpg-vit-url').val(settings.baseUrl).on('input', function () { settings.baseUrl = $(this).val().trim(); saveSettings(); });
    $('#rpg-vit-key').val(settings.apiKey).on('input', function () { settings.apiKey = $(this).val().trim(); saveSettings(); });
    $('#rpg-vit-model').val(settings.model).on('input', function () { settings.model = $(this).val().trim(); saveSettings(); });
}

jQuery(() => {
    loadSettings();
    pruneOldStates();
    setupUI();
    if (getContext().chatId) { loadState(); renderButton(); buildInjection(); }

    eventSource.on(event_types.CHAT_CHANGED, (chatIdArg) => {
        // Release the previous chat's state at once: other modules react to this event too, and a
        // bridge call made before the switch completes must not save into the new chat.
        stateReady = false; currentChatId = null; pendingChatId = chatIdArg || null;
        state = freshState();
        setTimeout(() => { loadState(pendingChatId || getContext().chatId); renderButton(); _builtSig = null; renderPanel(); buildInjection(); }, 100);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => onBotMessage(id));
    if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, (id) => onUserMessage(id));
});

// ============================================================
// CROSS-EXTENSION BRIDGE — lets Vendors/Inventory affect HP & effects.
// ============================================================
window.RPG = window.RPG || {};
window.RPG.vitals = {
    available: true,
    isEnabled: () => !!settings.enabled,
    getHp: () => { syncChat(); return state ? { hp: state.hp, max: state.maxHp } : null; },
    getHunger: () => { syncChat(); return state ? state.hunger : null; },
    feed: (n) => { syncChat(); return state ? feed(n) : 0; },
    heal: (n) => { syncChat(); if (state) heal(n); },
    damage: (n) => { syncChat(); if (state) damage(n); },
    setHp: (n, max) => { syncChat(); if (state) setHp(n, max); },
    addBuff: (b) => { syncChat(); return state ? addBuff(b) : null; },
    removeBuff: (key) => { syncChat(); if (state) removeBuff(key); },
    listBuffs: () => { syncChat(); return state ? state.buffs.map(b => ({ name: b.name, effect: b.effect, kind: b.kind, duration: b.duration })) : []; },
    getMana: () => { syncChat(); return state ? state.mana : null; },
    setMana: (n) => { syncChat(); if (state) setMana(n); },
    addMana: (n) => { syncChat(); if (state) addMana(n); },
    getFatigue: () => { syncChat(); return state ? state.fatigue : null; },
    setFatigue: (n) => { syncChat(); if (state) setFatigue(n); },
    addFatigue: (n) => { syncChat(); if (state) addFatigue(n); },
    getLevel: () => { syncChat(); return state ? state.level : null; },
    addXp: (n) => { syncChat(); if (state) addXp(n); },
    refresh: () => { loadState(getContext().chatId); _builtSig = null; renderPanel(); buildInjection(); }
};
