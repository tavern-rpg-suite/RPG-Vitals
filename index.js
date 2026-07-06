import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, setExtensionPrompt, extension_prompt_roles } from '../../../../script.js';

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
    autoDetect: false,
    combatInject: true,
    combatDepth: 1,
    combatAuto: false,
    combatScanMsgs: 4,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'google/gemma-4-31b-it',
    temperature: 0.8,
    chatStates: {}
};

let settings = {};
let state = null;

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
        inject_hp: "{{user}}'s HP: {hp}/{max}", inject_effects: 'Active effects',
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
        inject_hp: 'HP игрока {{user}}: {hp}/{max}', inject_effects: 'Активные эффекты',
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
function t(key, vars) {
    const lang = settings.language === 'ru' ? 'ru' : 'en';
    let str = (I18N[lang] && I18N[lang][key] !== undefined) ? I18N[lang][key] : (I18N.en[key] !== undefined ? I18N.en[key] : key);
    if (vars) for (const k in vars) str = str.split('{' + k + '}').join(vars[k]);
    return str;
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    settings = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME]);
    if (!settings.chatStates) settings.chatStates = {};
}
function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

function freshState() { return { hp: settings.defaultMaxHp || 100, maxHp: settings.defaultMaxHp || 100, buffs: [], hunger: 100, hungerTick: 0, enemies: [], level: 1, xp: 0, mana: 100, fatigue: 0 }; }
function loadState() {
    const chatId = getContext().chatId;
    if (!chatId) { state = freshState(); return; }
    if (settings.chatStates[chatId]) {
        state = settings.chatStates[chatId];
        if (typeof state.hp !== 'number') state.hp = settings.defaultMaxHp || 100;
        if (typeof state.maxHp !== 'number') state.maxHp = settings.defaultMaxHp || 100;
        if (!Array.isArray(state.buffs)) state.buffs = [];
        if (typeof state.hunger !== 'number') state.hunger = 100;
        if (typeof state.hungerTick !== 'number') state.hungerTick = 0;
        if (!Array.isArray(state.enemies)) state.enemies = [];
        if (typeof state.level !== 'number') state.level = 1;
        if (typeof state.xp !== 'number') state.xp = 0;
        if (typeof state.mana !== 'number') state.mana = 100;
        if (typeof state.fatigue !== 'number') state.fatigue = 0;
    } else {
        state = freshState();
        settings.chatStates[chatId] = state;
    }
}
function saveState() {
    const chatId = getContext().chatId;
    if (chatId) settings.chatStates[chatId] = state;
    saveSettings();
}

function clampHp() { state.hp = Math.max(0, Math.min(state.maxHp || 100, Math.round(state.hp))); }
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
    // No explicit duration → optionally fade after a random number of messages
    if (dur == null && settings.autoExpire) {
        const maxN = Math.max(1, parseInt(settings.autoExpireMax) || 20);
        dur = 1 + Math.floor(Math.random() * maxN); // 1..maxN
    }
    const buff = {
        id: genId(), name: String(b.name), effect: String(b.effect || ''),
        kind: (b.kind === 'debuff') ? 'debuff' : 'buff',
        duration: dur // null = until removed
    };
    state.buffs.push(buff); saveState(); renderPanel(); buildInjection();
    return buff;
}
function removeBuff(id) { state.buffs = state.buffs.filter(b => b.id !== id); saveState(); renderPanel(); buildInjection(); }

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
function attackEnemy(id) {
    const e = state.enemies.find(x => x.id === id); if (!e) return;
    const dmg = playerAttackPower();
    e.hp = Math.max(0, e.hp - dmg);
    if (e.hp <= 0) {
        toastr.success(t('toast_hit_enemy', { name: e.name, n: dmg, hp: 0, max: e.max }));
        toastr.warning(t('toast_enemy_down', { name: e.name }));
        gainKillXp(e);
        state.enemies = state.enemies.filter(x => x.id !== id);
    } else {
        toastr.info(t('toast_hit_enemy', { name: e.name, n: dmg, hp: e.hp, max: e.max }));
    }
    saveState(); renderPanel(); buildInjection();
}
function enemyHitsYou(id) {
    const e = state.enemies.find(x => x.id === id); if (!e) return;
    toastr.warning(t('toast_enemy_hit', { name: e.name, n: e.atk || 0 }));
    damage(e.atk || 0); // armour from equipment soaks part of it inside damage()
}

function genLang() { return settings.language === 'ru' ? 'Russian' : 'English'; }
async function callAI(systemPrompt, userPrompt) {
    if (!settings.apiKey) throw new Error('API key is not set!');
    const endpointUrl = (settings.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '') + '/chat/completions';
    for (let i = 0; i < 2; i++) {
        try {
            const response = await fetch(endpointUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${settings.apiKey.trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: settings.model,
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                    temperature: settings.temperature, response_format: { type: 'json_object' }
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
async function analyzeMessage(messageId) {
    if (!settings.enabled || !settings.autoDetect || !settings.apiKey || !state) return;
    const msg = getContext().chat[messageId];
    if (!msg || msg.is_user || msg.is_system || !msg.mes) return;
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
        let rules = '';
        if (settings.hungerEnabled) { fields += ',"hunger_delta":0'; }
        if (settings.manaEnabled) { fields += ',"mana_delta":0'; rules += `\n- "mana_delta": mana "${who}" spent (negative, e.g. casting/using magic) or recovered (positive, e.g. rest/potion/meditation) THIS message.`; }
        if (settings.fatigueEnabled) { fields += ',"fatigue_delta":0'; rules += `\n- "fatigue_delta": how much MORE tired "${who}" got (positive: hard exertion, fighting, sprinting, no sleep) or how much they recovered (negative: rest/sleep) THIS message.`; }
        if (settings.levelEnabled) { fields += ',"xp_delta":0'; rules += `\n- "xp_delta": experience for a real achievement by "${who}" THIS message (finishing a quest, a big victory, a breakthrough) — usually 0, occasionally 10–40. Do NOT award xp just for talking.`; }

        const sys = `You track the physical state of "${who}" (the player/user) in a roleplay. ${partner ? `"${partner}" is the scene character, NOT "${who}" — report only what changed for "${who}", never for "${partner}".` : ''} Read ONLY the latest scene text and report what actually changed for "${who}" in THIS message.
Be conservative: most messages change nothing — then return zeros and empty arrays. Only react to clear events (taking a hit, healing/resting, eating/drinking, being poisoned/drunk/blessed/exhausted, an effect ending).
Current HP ${state.hp}/${state.maxHp}${hungerInfo}${manaInfo}${fatigueInfo}${lvlInfo}. Current effects: ${effList}.${rules}
Write any effect names/descriptions in ${genLang()}.
Output strictly JSON: {${fields}}`;
        const res = await callAI(sys, String(msg.mes).slice(0, 2000));
        if (!res) return;
        const notes = [];
        if (typeof res.hp_delta === 'number' && res.hp_delta !== 0) {
            let hpd = res.hp_delta;
            if (hpd < 0 && settings.combatAuto) hpd = 0; // combat scan owns incoming damage — avoid double-subtracting
            if (hpd > 0) { heal(hpd); notes.push(`HP +${hpd}`); }
            else if (hpd < 0) { damage(-hpd); notes.push(`HP ${hpd}`); }
        }
        if (settings.hungerEnabled && typeof res.hunger_delta === 'number' && res.hunger_delta !== 0) { setHunger(state.hunger + res.hunger_delta); notes.push(`${t('hunger')} ${res.hunger_delta > 0 ? '+' : ''}${res.hunger_delta}`); }
        if (settings.manaEnabled && typeof res.mana_delta === 'number' && res.mana_delta !== 0) { addMana(res.mana_delta); notes.push(`${t('mana_word')} ${res.mana_delta > 0 ? '+' : ''}${res.mana_delta}`); }
        if (settings.fatigueEnabled && typeof res.fatigue_delta === 'number' && res.fatigue_delta !== 0) { addFatigue(res.fatigue_delta); notes.push(`${t('fatigue_word')} ${res.fatigue_delta > 0 ? '+' : ''}${res.fatigue_delta}`); }
        if (settings.levelEnabled && typeof res.xp_delta === 'number' && res.xp_delta > 0) { addXp(res.xp_delta); notes.push(`${t('xp')} +${res.xp_delta}`); }
        for (const e of (Array.isArray(res.add_effects) ? res.add_effects : [])) if (e && e.name) { addBuff(e); notes.push((e.kind === 'debuff' ? '−' : '+') + e.name); }
        for (const nm of (Array.isArray(res.remove_effects) ? res.remove_effects : [])) { const b = state.buffs.find(x => x.name === nm); if (b) removeBuff(b.id); }
        if (notes.length) toastr.info(t('auto_changed') + ' ' + notes.join(', '));
    } catch (e) { /* silent: don't disrupt chat on API errors */ }
}
async function analyzeCombat(messageId) {
    if (!settings.enabled || !settings.combatAuto || !settings.apiKey || !state) return;
    const ctx = getContext();
    const msg = ctx.chat[messageId];
    if (!msg || msg.is_user || msg.is_system || !msg.mes) return;
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
        if (!res) return;
        const notes = [];
        for (const e of (Array.isArray(res.new_enemies) ? res.new_enemies : [])) {
            if (e && e.name && !state.enemies.some(x => x.name.toLowerCase() === String(e.name).toLowerCase())) {
                addEnemy(e.name, e.hp, e.atk); notes.push(t('c_appears', { name: e.name }));
            }
        }
        for (const h of (Array.isArray(res.hits_on_enemies) ? res.hits_on_enemies : [])) {
            if (!h || !h.name || !(h.dmg > 0)) continue;
            const e = state.enemies.find(x => x.name.toLowerCase() === String(h.name).toLowerCase());
            if (!e) continue;
            e.hp = Math.max(0, e.hp - Math.round(h.dmg));
            if (e.hp <= 0) { gainKillXp(e); state.enemies = state.enemies.filter(x => x.id !== e.id); notes.push(t('c_down', { name: e.name })); }
            else notes.push(t('c_hit', { name: e.name, n: Math.round(h.dmg) }));
        }
        for (const nm of (Array.isArray(res.fled) ? res.fled : [])) {
            const before = state.enemies.length;
            state.enemies = state.enemies.filter(x => x.name.toLowerCase() !== String(nm).toLowerCase());
            if (state.enemies.length < before) notes.push(t('c_fled', { name: nm }));
        }
        // incoming damage goes through armour (mitigation + wear handled inside damage())
        if (typeof res.damage_to_player === 'number' && res.damage_to_player > 0) {
            damage(res.damage_to_player);
        }
        saveState(); renderPanel(); buildInjection();
        if (notes.length) toastr.info(t('combat_changed') + ' ' + notes.join(', '));
    } catch (e) { /* silent: never disrupt chat on API errors */ }
}
function tickBuffs(messageId) {
    if (!settings.enabled || !state) return;
    const msg = getContext().chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    let expired = null;
    state.buffs = state.buffs.filter(b => {
        if (b.duration == null) return true;
        b.duration -= 1;
        if (b.duration <= 0) { expired = b.name; return false; }
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
    if (expired) toastr.info(t('toast_expired', { name: expired }));
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
        const list = state.enemies.map(e => `${e.name} ${e.hp}/${e.max}`).join(', ');
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
        $('#rpg-vit-modal .rpg-modal-close').on('click', () => $('#rpg-vit-modal').removeClass('visible'));
        window.addEventListener('resize', () => { if ($('#rpg-vit-modal').hasClass('visible')) fitCard(); });
    }
    if (!settings.enabled) { $('#rpg-vit-btn').hide(); return; }
    $('#rpg-vit-btn').show();
    $('#rpg-vit-btn').off('click').on('click', () => { renderPanel(); $('#rpg-vit-modal').toggleClass('visible'); });
}
function makeModalDraggable(elmnt, handle) {
    let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
    if (!handle) return;
    handle.onmousedown = (e) => {
        if (e.target.closest('.rpg-modal-close, .vex-close, button, input, select, .vex-b-del, .rpg-vit-e-del')) return;
        e.preventDefault(); p3 = e.clientX; p4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (ev) => {
            ev.preventDefault(); p1 = p3 - ev.clientX; p2 = p4 - ev.clientY; p3 = ev.clientX; p4 = ev.clientY;
            elmnt.style.top = (elmnt.offsetTop - p2) + 'px'; elmnt.style.left = (elmnt.offsetLeft - p1) + 'px';
        };
    };
}

function renderPanel() {
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
            <path class="live" pathLength="1" style="stroke:${hpc};" d="${ecgPath}"/>
        </svg>
        ${flat ? '' : `<span class="vex-blip" style="background:${hpc};"></span>`}
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
            return `<div class="vex-s filled ${deb ? 'debuff' : ''}" title="${escapeHtml(b.name + (b.effect ? ' — ' + b.effect : ''))}">
                ${deb ? DOWN : UP}
                ${b.duration == null ? '' : `<span class="vex-dur">${b.duration}</span>`}
                ${gm ? `<span class="vex-b-del rpg-vit-b-del" data-id="${b.id}">✕</span>` : ''}
            </div>`;
        }).join('');
        efflist = `<div class="vex-efflist">` + state.buffs.map(b => `<div class="vex-efl ${b.kind === 'debuff' ? 'debuff' : ''}">
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
        ${state.enemies.length ? state.enemies.map(e => {
            const epct = Math.max(0, Math.min(100, Math.round(e.hp / (e.max || 1) * 100)));
            return `<div class="vex-enemy">
                <div class="rpg-vit-hp-top"><span class="rpg-vit-b-name">${escapeHtml(e.name)}</span><span class="rpg-vit-hp-num">${e.hp}/${e.max}${e.atk ? ` · ${escapeHtml(t('enemy_atk_ph'))} ${e.atk}` : ''} <i class="fa-solid fa-xmark rpg-vit-e-del" data-id="${e.id}" title="${escapeHtml(t('remove'))}" style="cursor:pointer;color:var(--sepia);margin-left:6px;"></i></span></div>
                <div class="rpg-vit-bar-wrap"><div class="rpg-vit-bar" style="width:${epct}%; background:#b0432f;"></div></div>
                ${gm ? `<div class="vex-ctrl">
                    <button class="rpg-vit-btn ok rpg-vit-atk" data-id="${e.id}"><i class="fa-solid fa-gavel"></i> ${escapeHtml(t('attack'))}</button>
                    <button class="rpg-vit-btn danger rpg-vit-ehit" data-id="${e.id}"><i class="fa-solid fa-burst"></i> ${escapeHtml(t('enemy_hit'))}</button>
                </div>` : ''}
            </div>`;
        }).join('') : `<div class="vex-eff-note">${escapeHtml(t('no_enemies'))}</div>`}
        ${gm ? `<div class="vex-add"><div class="vex-add-row">
            <input type="text" class="text_pole rpg-vit-e-name" placeholder="${escapeHtml(t('enemy_name_ph'))}">
            <input type="number" class="text_pole rpg-vit-e-hp" placeholder="${escapeHtml(t('enemy_hp_ph'))}" min="1" style="width:60px;">
            <input type="number" class="text_pole rpg-vit-e-atk" placeholder="${escapeHtml(t('enemy_atk_ph'))}" min="0" style="width:60px;">
            <button class="rpg-vit-btn ok rpg-vit-e-add"><i class="fa-solid fa-plus"></i> ${escapeHtml(t('add_enemy'))}</button>
        </div></div>` : ''}` : '';

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
            <div class="vex-vlabel"><div class="left">${HEART}<span class="vex-k">${escapeHtml(t('lbl_health'))}</span></div><span class="vex-v">${state.hp} / ${state.maxHp}</span></div>
            ${ecg}
            ${hpCtrl}
        </div>
        ${settings.hungerEnabled ? `<div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${FOOD}<span class="vex-k">${escapeHtml(t('lbl_satiety'))}</span></div><span class="vex-v">${state.hunger} / 100</span></div>
            <div class="vex-cells">${cells}</div>
            ${hungerCtrl}
        </div>` : ''}
        ${settings.manaEnabled ? `<div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${MANA}<span class="vex-k">${escapeHtml(t('lbl_mana'))}</span></div><span class="vex-v">${state.mana} / 100</span></div>
            <div class="vex-cells mana">${manaCells}</div>
            ${manaCtrl}
        </div>` : ''}
        ${settings.fatigueEnabled ? `<div class="vex-vital">
            <div class="vex-vlabel"><div class="left">${FATIGUE}<span class="vex-k">${escapeHtml(t('lbl_fatigue'))}</span></div><span class="vex-v">${state.fatigue} / 100</span></div>
            <div class="vex-cells fatigue">${fatCells}</div>
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
    body.find('.rpg-vit-e-del').off('click').on('click', function () { removeEnemy($(this).data('id')); });
    body.find('.rpg-vit-e-add').off('click').on('click', function () {
        const name = body.find('.rpg-vit-e-name').val().trim();
        if (!name) { toastr.warning(t('toast_need_ename')); return; }
        addEnemy(name, body.find('.rpg-vit-e-hp').val(), body.find('.rpg-vit-e-atk').val());
    });

    $('#rpg-vit-modal').toggleClass('vex-wide', !!settings.gmControls);
    fitCard();
    const dragEl = body.find('#vex-drag')[0];
    if (dragEl) makeModalDraggable(document.getElementById('rpg-vit-modal'), dragEl);
}

function fitCard() {
    const fit = document.querySelector('#rpg-vit-body .vex-fit');
    const card = document.querySelector('#rpg-vit-body .vex');
    if (!fit || !card) return;
    // Only downscale for narrow WIDTH (small screens). Never scale by height —
    // a tall card scrolls inside the panel instead of being squished.
    fit.style.transform = 'none';
    fit.style.height = 'auto';
    const cardW = card.offsetWidth || 372;
    const availW = Math.min(cardW + 8, window.innerWidth * 0.96) - 4;
    const s = Math.min(1, availW / cardW);
    fit.style.transformOrigin = 'top center';
    fit.style.transform = 'scale(' + s + ')';
    if (s < 1) fit.style.height = (card.offsetHeight * s + 30) + 'px';
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
    $('#rpg-vit-depth').val(settings.injectDepth).on('change', function () { settings.injectDepth = parseInt($(this).val()); saveSettings(); buildInjection(); });
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
    setupUI();
    if (getContext().chatId) { loadState(); renderButton(); buildInjection(); }

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => { loadState(); renderButton(); renderPanel(); buildInjection(); }, 100);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => { tickBuffs(id); analyzeMessage(id); analyzeCombat(id); });
});

// ============================================================
// CROSS-EXTENSION BRIDGE — lets Vendors/Inventory affect HP & effects.
// ============================================================
window.RPG = window.RPG || {};
window.RPG.vitals = {
    available: true,
    isEnabled: () => !!settings.enabled,
    getHp: () => state ? { hp: state.hp, max: state.maxHp } : null,
    getHunger: () => state ? state.hunger : null,
    feed: (n) => state ? feed(n) : 0,
    heal: (n) => { if (state) heal(n); },
    damage: (n) => { if (state) damage(n); },
    setHp: (n, max) => { if (state) setHp(n, max); },
    addBuff: (b) => state ? addBuff(b) : null,
    listBuffs: () => state ? state.buffs.map(b => ({ name: b.name, effect: b.effect, kind: b.kind, duration: b.duration })) : [],
    getMana: () => state ? state.mana : null,
    setMana: (n) => { if (state) setMana(n); },
    addMana: (n) => { if (state) addMana(n); },
    getFatigue: () => state ? state.fatigue : null,
    setFatigue: (n) => { if (state) setFatigue(n); },
    addFatigue: (n) => { if (state) addFatigue(n); },
    getLevel: () => state ? state.level : null,
    addXp: (n) => { if (state) addXp(n); },
    refresh: () => { loadState(); renderPanel(); buildInjection(); }
};
