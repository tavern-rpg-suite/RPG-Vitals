import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveChatDebounced, saveSettingsDebounced, setExtensionPrompt, extension_prompt_roles } from '../../../../script.js';
import { user_avatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { selected_world_info } from '../../../world-info.js';
import './suite-core.js';   // the suite's shared core: one seal for the floating buttons, the request queue, one "when and where"

const MODULE_NAME = 'rpg_vitals';
const PROMPT_KEY = 'rpg_vitals_injection';
const PROMPT_KEY_STARVE = 'rpg_vitals_starving';
const PROMPT_KEY_COMBAT = 'rpg_vitals_combat';

const defaultSettings = {
    enabled: false,
    language: 'en',
    injectDepth: 1,
    inChat: false,         // off: the blocks go to the top of the prompt, as always; on: into the chat at the depths below (a local model then re-reads only the end)
    defaultMaxHp: 100,
    hungerEnabled: false,
    hungerDrainEvery: 3,
    hungerDrainAmount: 5,
    starveDamage: 2,
    autoExpire: true,
    autoExpireMax: 20,
    stackEffects: true,       // a second "Soreness" joins the first as ×2 instead of a new line
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
    intimacyEnabled: false,   // intimate scenes leave effects too — read by the same story scan, no extra call
    playerSex: '',            // the player's body: '' (not said) | 'f' | 'm' | 'x'
    playerCycle: false,       // a woman player's cycle, counted by code on the story's own days
    playerPregnancy: false,   // a chance of pregnancy after a night — off until asked for
    playerHidePreg: true,     // nobody knows until the period is late
    playerPill: false,        // she takes the pill
    cycleDayEvery: 30,        // with no Scene Card date: a new day every N replies
    playerTraits: {},         // per persona, for good: { len, period, pain, fertile, rolls }
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'google/gemma-4-31b-it',
    temperature: 0.4,
    strictJson: true,
    chatStates: {},
    chatStamps: {},  // chatId -> last-used timestamp, lets stale states be pruned
    // the skill tree: on, only while a trial runs, the line's depth, branches, its texts ('' = standard), the trees by persona
    skillsEnabled: true, skillsOnlyTrials: true, skillDepth: 2, skillBranches: 2,
    skillClassesOn: true, skillScanCard: true, skillScanLore: true,   // the class step, and what it reads about the world
    skillPrompt: '', skillUseLine: '', skillComboLine: '', skillClassPrompt: '', skillTrees: {}, skillClasses: {}
};

let settings = {};
let state = null;
let vitalsBusy = false; // false, or the turnEpoch of the analysis in flight — re-entrancy lock so auto-analyses can't stack/loop (prevents freezes after eating)
let _builtSig = null;   // signature of the last full panel build — lets stat updates repaint in place (no flicker)
let turnEpoch = 0;          // bumped whenever the state is rewound; analyses of an older variant then drop their result
let turnInFlight = null;    // { id, key } of the variant being analysed now
let turnMsgRef = null;
let turnPending = false;    // a swipe asked for a new variant; if the generation stops, the old one's result comes back      // the chat message state.turn belongs to (by object, so deleting an EARLIER message is told apart)

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
        set_lang: 'Language:', set_depth: 'Context injection depth:', set_inchat: 'Insert in chat', set_depth_off: 'Works with "Insert in chat"', set_maxhp: 'Default max HP:',
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
        set_stack: 'Similar effects stack (Soreness ×2) instead of a second line',
        set_autoexpire: 'Fade effects with no set duration', set_autoexpire_max: 'random up to (messages):',
        set_mana: 'Enable mana (the story raises and spends it)',
        set_fatigue: 'Enable fatigue (rises with exertion, falls with rest)',
        sec_api: 'Connection', sec_health: 'Health & effects', sec_hunger: 'Hunger', sec_extra: 'Level, mana, fatigue', sec_scan: 'Reading the scene', sec_combat: 'Combat', sec_angel: 'Angel',
        sec_skills: 'Skill tree', set_sk_en: 'Skill tree (a 🌿 button on the card, skills in the message box)', set_sk_trials: 'Skills work only in a dungeon (RPG Map)',
        set_sk_classes: 'Choose a class before the tree grows', set_sk_scancard: 'Classes and the tree read the character card', set_sk_scanlore: 'Classes and the tree read the lorebooks',
        set_sk_depth: 'Skill line depth:', set_sk_branches: 'Branches in a new tree:', set_sk_prompts: 'Texts for the model', set_sk_reset: 'Restore default',
        set_sk_p_tree: 'Making the tree · {NAME} {SOURCE} {WORLD} {CLASS} {BRANCHES} {LANG}', set_sk_p_class: 'Suggesting classes · {NAME} {SOURCE} {WORLD} {N} {LANG}',
        sk_class_h: 'Class', sk_class_suggest: 'Suggest classes for this world', sk_class_more: 'Other classes', sk_class_busy: 'Reading the world…', sk_class_fail: 'Could not suggest classes — check the connection or try another model.',
        sk_class_own: 'Or your own', sk_class_own_ph: 'Your own class…', sk_class_now: 'The tree will grow around: {name}', sk_class_none: 'No class: the tree grows from the persona alone',
        sk_regrow: 'A new tree: the class decides what the branches are about.', sk_back_tree: 'Back to the tree', set_sk_p_use: 'Line when a skill is used · {NAME} {SKILL} {DESC} {COST} {SIDE}', set_sk_p_combo: 'Line for a joint move · {NAME} {PARTNER} {SKILL} {RESULT}',
        sk_tree: 'Skill tree', sk_bar: 'Skills', sk_stage: 'The tree: drag to move, wheel or + and − to zoom',
        sk_empty: 'The class decides what the branches are about.', sk_empty_plain: 'The tree grows from your persona and this story.', sk_make: 'Grow the tree', sk_make_note: 'One request to the model, once for your persona in this story.',
        sk_making: 'Growing the tree…', sk_made: 'The tree has grown.', sk_make_fail: 'The tree could not be grown', sk_fail_shape: 'the model answered, but not with a tree (its answer is in the console, F12)', sk_fail_empty: 'the model gave an empty answer', sk_part: 'The tree is unfinished: the model wrote {n} skills of {all}, twice{why}. “Grow anew” tries again.', sk_stop_len: 'it ran out of answer length (raise the context size of your local server)', sk_tok: '(read {i} tokens, wrote {o})', sk_no_key: 'No API key in RPG Vitals.',
        sk_grow: 'Branch', sk_grow_t: 'The tree is full: three spare points grow it one more branch', sk_growing: 'Growing…', sk_grown: 'A new branch has grown', sk_grow_fail: 'Could not grow a branch', sk_crafts: 'Crafts', sk_crafts_t: 'Crafts learned at RPG Vendors: their lasting bonuses, and the skill points their mastery gave this tree', sk_grow_soon: '{n} more point(s) and the tree grows a new branch', sk_remake: 'Grow anew', sk_remake_q: 'Grow a new tree? The skills learned in this chat are forgotten.', sk_reset: 'Forget the skills', sk_reset_q: 'Forget every skill learned in this chat? The points come back.',
        sk_pts: 'Points: {n}', sk_pts_t: 'One at the start, one per level, and those won in trials', sk_lvl: 'Level {n}', sk_lvl_off: 'Levels are off: points come only from trials',
        sk_st_taken: 'Learned', sk_st_sealed: 'Sealed: the other skill of this tier was chosen', sk_st_locked: 'Learn a skill of the tier below first', sk_st_open: 'Can be learned', sk_st_nopoints: 'No points left',
        sk_take: 'Learn · 1 point', sk_learned: 'Learned', sk_pin: 'To the bar', sk_unpin: 'Take off the bar', sk_on_bar: 'On the bar', sk_close_d: 'Close', sk_on_whom: 'on whom?', sk_self: 'Myself', sk_fx_on: 'on {name}', sk_box_on: '*{name} uses "{skill}" on {target}: {desc}*', sk_next_reply: 'It is in your message: send it', sk_box_use: '*{name} uses "{skill}": {desc}*', sk_box_combo: '*{name} calls {partner} for a joint move: "{skill}".*', sk_with: 'With whom',
        sk_price: 'Price', sk_side: 'Side effect: {name}, {n} turns', sk_cd_every: 'Again after {n} replies', sk_cooldown: 'ready in {n} replies',
        sk_k_damage: 'Strike', sk_k_heal: 'Healing', sk_k_shield: 'Shield', sk_k_summon: 'Summoning', sk_k_reveal: 'Revealing', sk_k_escape: 'Escape', sk_k_sway: 'Persuasion', sk_k_trick: 'Trick',
        sk_used: 'Skill', sk_only_trials: 'Skills wake only in a dungeon.', sk_off: 'The skill tree is off.', sk_no_mana: 'Not enough mana.', sk_too_tired: 'Too tired for that.',
        sk_fx_hit: '{name} −{n}', sk_fx_down: '{name} is down', sk_fx_heal: '+{n} HP', sk_fx_buff: '{name} is on',
        sk_combo: 'Joint move', sk_trust: 'Trust {n}% — the chance to join in', sk_trust_none: 'Trust unknown: even odds',
        sk_combo_ok: '{name} joined in! ({roll} of {chance})', sk_combo_fail: '{name} did not join in ({roll}, needed {chance} or less)',
        sk_zoom_in: 'Zoom in', sk_zoom_out: 'Zoom out', sk_zoom_fit: 'Back to the start',
        set_intimacy: 'Notice intimate scenes (afterglow, marks, soreness…)',
        set_intimacy_hint: 'Works inside the same reading of the scene — no extra request. Needs "Auto-update from the story".',
        intimacy_toast: 'After the night with {name}:', intimacy_toast_anon: 'After the intimate scene:',
        set_ppill: 'I take the pill', set_pend: 'The pregnancy is over', p_end_done: 'The pregnancy is over; the cycle starts again.', p_prot: 'Protected: {what}', w_condom: 'a condom', w_pill: 'the pill', w_story: 'contraception in the scene', condom_bag: 'A condom from your backpack was used.',
        sec_body: 'Your body', set_psex: 'Your body:', psex_none: '— not said —', psex_f: 'female', psex_m: 'male', psex_x: 'other',
        set_pcycle: 'Menstrual cycle (rolled once for you)', set_ppreg: 'A chance of pregnancy after an intimate scene', set_phide: 'Keep it hidden until the period is late',
        set_pday: 'Today is cycle day', set_pevery: 'No Scene Card date: a new day every N replies', set_preroll: 'Roll again',
        p_rolls: 'Cycle {len} d, period {per} d, {pain}; {fert} (dice {r})', p_fert_y: 'can have children', p_fert_n: 'cannot have children',
        pain0: 'no pain', pain1: 'mild cramps', pain2: 'cramps', pain3: 'strong cramps',
        lbl_cycle: 'Cycle', cyc_day: 'day {d} of {n}', ph_period: 'Period', ph_follicular: 'Calm days', ph_ovulation: 'Ovulation', ph_luteal: 'Second half', ph_pms: 'Before the period',
        late_n: 'Period late · {n} d', preg_w: 'Pregnant · {w} wk',
        eff_period: 'Period', eff_period_d: ['uncomfortable, nothing more', 'mild cramps', 'cramps — hard to focus', 'strong cramps — wants to lie down'],
        eff_pms: 'Before the period', eff_pms_d: 'touchier than usual, craves sweets',
        eff_ovu: 'Ovulation', eff_ovu_d: 'more energy, drawn to closeness',
        eff_late: 'Period late', eff_late_d: 'it has not come for {n} days',
        eff_preg: 'Pregnancy', eff_preg_d: 'about {w} weeks — tires faster, sometimes nauseous',
        eff_preg_t1: 'about {w} weeks — nauseous in the mornings, odd cravings', eff_preg_t2: 'about {w} weeks — the belly is starting to show', eff_preg_t3: 'about {w} weeks — heavy now, tires quickly, the back aches', eff_preg_term: '{w} weeks — the time has come, the first contractions come and go',
        eff_baby: 'Newborn nights', eff_baby_d: 'a newborn keeps you up at night — short on sleep'
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
        vex_sub: 'МЕДИЦИНСКИЙ ОСМОТР', exam_b: 'ОСМОТР', exam_i: 'осмотр', lbl_health: 'ЗДОРОВЬЕ · HP', lbl_satiety: 'СЫТОСТЬ', lbl_effects: 'ЭФФЕКТЫ', clean: 'ЧИСТО', close: 'Закрыть',
        combat: 'Бой', add_enemy: 'Добавить врага', enemy_name_ph: 'Имя врага', enemy_hp_ph: 'HP', enemy_atk_ph: 'Урон',
        attack: 'Атаковать', enemy_hit: 'Удар по мне', no_enemies: 'Врагов нет.',
        toast_hit_enemy: 'Ты бьёшь «{name}» на {n} (осталось {hp}/{max}).', toast_enemy_down: '«{name}» повержен!',
        toast_enemy_hit: '«{name}» атакует тебя (входящий урон {n}).', toast_need_ename: 'Введите имя врага.',
        inject_combat: 'Идёт бой — враги: {list}. {{user}} {weapon}', inj_weaponed: 'с оружием {name} (урон {atk})', inj_unarmed: 'без оружия',
        set_combat_inject: 'Вставлять состояние боя / врагов в подсказку', set_combat_depth: 'Глубина вставки боя:',
        set_combat_auto: 'Разрешить ИИ сканировать чат на бой (выкл = только нарратив)', set_combat_scan: 'Сколько последних сообщений сканировать (1–10):',
        combat_changed: 'Бой:', c_appears: 'появился «{name}»', c_hit: '«{name}» −{n}', c_down: '«{name}» повержен', c_fled: '«{name}» сбежал',
        set_title: 'RPG Vitals (HP и эффекты)', set_enable: 'Включить состояние',
        set_lang: 'Язык:', set_depth: 'Глубина вставки в контекст:', set_inchat: 'Вставлять в чат', set_depth_off: 'Работает с «Вставлять в чат»', set_maxhp: 'Макс. HP по умолчанию:',
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
        angel_chat_win: '{name}: милость дарована. Ангел отправляет {{user}} обратно — к живым, вопреки всему.',
        toast_starving: '{{user}} голодает!', toast_fed: 'Сытость +{n}.',
        set_hunger: 'Включить голод (убывает по сообщениям)', set_hunger_every: 'Убывает каждые N сообщений бота:', set_hunger_amount: 'Сколько сытости теряется за раз:', set_starve_dmg: 'HP теряется за сообщение при голоде:',
        set_autodetect: 'Авто-обновление HP / сытости / эффектов из сюжета', set_gm: 'Показывать ручные кнопки (режим мастера)', set_url: 'API URL:', set_key: 'API-ключ:', set_model: 'Модель:', auto_changed: 'Сцена изменила твоё состояние.',
        lbl_level: 'УРОВЕНЬ', lbl_mana: 'МАНА', lbl_fatigue: 'УСТАЛОСТЬ',
        level_word: 'Уровень', mana_word: 'Мана', fatigue_word: 'Усталость', xp: 'ОП', set_setlbl: 'Задать',
        toast_levelup: 'Новый уровень! Теперь ты {n} уровня.',
        inject_level: 'Уровень {n}', inject_mana: 'Мана: {m}/100', inject_fatigue: 'Усталость: {f}/100 (больше = сильнее устал)',
        set_level: 'Включить уровень (опыт с побеждённых врагов + вехи от ИИ, макс 100)',
        set_stack: 'Похожие эффекты складываются (Ломота ×2), а не идут второй строкой',
        set_autoexpire: 'Гасить эффекты без заданной длительности', set_autoexpire_max: 'рандом до (сообщений):',
        set_mana: 'Включить ману (сюжет её тратит и восполняет)',
        set_fatigue: 'Включить усталость (растёт от нагрузки, падает при отдыхе)',
        sec_api: 'Подключение', sec_health: 'Здоровье и эффекты', sec_hunger: 'Голод', sec_extra: 'Уровень, мана, усталость', sec_scan: 'Чтение сцены', sec_combat: 'Бой', sec_angel: 'Ангел',
        sec_skills: 'Древо навыков', set_sk_en: 'Древо навыков (кнопка 🌿 на карточке, навыки в поле ввода)', set_sk_trials: 'Навыки работают только во время испытания (RPG Map)',
        set_sk_classes: 'Выбирать класс перед древом', set_sk_scancard: 'Классы и древо читают карточку персонажа', set_sk_scanlore: 'Классы и древо читают лорбуки',
        set_sk_depth: 'Глубина строки навыка:', set_sk_branches: 'Веток в новом древе:', set_sk_prompts: 'Тексты для модели', set_sk_reset: 'Вернуть стандартное',
        set_sk_p_tree: 'Создание древа · {NAME} {SOURCE} {WORLD} {CLASS} {BRANCHES} {LANG}', set_sk_p_class: 'Подбор классов · {NAME} {SOURCE} {WORLD} {N} {LANG}',
        sk_class_h: 'Класс', sk_class_suggest: 'Подобрать классы под этот мир', sk_class_more: 'Другие классы', sk_class_busy: 'Читаю мир…', sk_class_fail: 'Не удалось подобрать классы — проверь подключение или попробуй другую модель.',
        sk_class_own: 'Или свой', sk_class_own_ph: 'Свой класс…', sk_class_now: 'Древо вырастет вокруг: {name}', sk_class_none: 'Без класса: древо вырастет из одной персоны',
        sk_regrow: 'Новое древо: класс решает, о чём будут ветки.', sk_back_tree: 'Назад к древу', set_sk_p_use: 'Строка при навыке · {NAME} {SKILL} {DESC} {COST} {SIDE}', set_sk_p_combo: 'Строка совместного приёма · {NAME} {PARTNER} {SKILL} {RESULT}',
        sk_tree: 'Древо навыков', sk_bar: 'Навыки', sk_stage: 'Древо: тащи, чтобы двигать; колесо или + и −, чтобы приблизить',
        sk_empty: 'Класс решает, о чём будут ветки.', sk_empty_plain: 'Древо вырастет из твоей персоны и этой истории.', sk_make: 'Вырастить древо', sk_make_note: 'Один запрос к модели, один раз для твоей персоны в этой истории.',
        sk_making: 'Древо растёт…', sk_made: 'Древо выросло.', sk_make_fail: 'Не удалось вырастить древо', sk_fail_shape: 'модель ответила, но не древом (её ответ в консоли, F12)', sk_fail_empty: 'модель вернула пустой ответ', sk_part: 'Древо недописано: модель дважды написала {n} навыков из {all}{why}. «Вырастить заново» — ещё попытка.', sk_stop_len: 'ей не хватило длины ответа (увеличь размер контекста у локального сервера)', sk_tok: '(прочитала {i} токенов, написала {o})', sk_no_key: 'В RPG Vitals нет ключа API.',
        sk_grow: 'Ветка', sk_grow_t: 'Древо заполнено: три лишних очка дорастят его новой веткой', sk_growing: 'Растёт…', sk_grown: 'Выросла новая ветка', sk_grow_fail: 'Не удалось вырастить ветку', sk_crafts: 'Ремёсла', sk_crafts_t: 'Ремёсла из RPG Vendors: их постоянные бонусы и очки навыка, которые мастерство дало этому древу', sk_grow_soon: 'ещё очков: {n} — и древо даст новую ветку', sk_remake: 'Вырастить заново', sk_remake_q: 'Вырастить новое древо? Навыки, изученные в этом чате, забудутся.', sk_reset: 'Забыть навыки', sk_reset_q: 'Забыть все навыки этого чата? Очки вернутся.',
        sk_pts: 'Очки: {n}', sk_pts_t: 'Одно на старте, по одному за уровень и выигранные в испытаниях', sk_lvl: 'Уровень {n}', sk_lvl_off: 'Уровни выключены: очки только из испытаний',
        sk_st_taken: 'Изучен', sk_st_sealed: 'Запечатан: на этом ярусе выбран другой навык', sk_st_locked: 'Сначала изучи навык ярусом ниже', sk_st_open: 'Можно изучить', sk_st_nopoints: 'Очков не осталось',
        sk_take: 'Изучить · 1 очко', sk_learned: 'Изучено', sk_pin: 'На панель', sk_unpin: 'Убрать с панели', sk_on_bar: 'На панели', sk_close_d: 'Закрыть', sk_on_whom: 'на кого?', sk_self: 'На себя', sk_fx_on: 'на {name}', sk_box_on: '*{name} использует «{skill}» на {target}: {desc}*', sk_next_reply: 'Он уже в твоём сообщении: отправь его', sk_box_use: '*{name} использует «{skill}»: {desc}*', sk_box_combo: '*{name} зовёт {partner} на совместный приём: «{skill}».*', sk_with: 'С кем',
        sk_price: 'Цена', sk_side: 'Побочный эффект: {name}, ходов: {n}', sk_cd_every: 'Снова через {n} ответов', sk_cooldown: 'готов через {n} отв.',
        sk_k_damage: 'Удар', sk_k_heal: 'Лечение', sk_k_shield: 'Щит', sk_k_summon: 'Призыв', sk_k_reveal: 'Прозрение', sk_k_escape: 'Побег', sk_k_sway: 'Убеждение', sk_k_trick: 'Уловка',
        sk_used: 'Навык', sk_only_trials: 'Навыки просыпаются только в испытании.', sk_off: 'Древо навыков выключено.', sk_no_mana: 'Не хватает маны.', sk_too_tired: 'Сил на это не хватит.',
        sk_fx_hit: '{name} −{n}', sk_fx_down: '{name} повержен', sk_fx_heal: '+{n} HP', sk_fx_buff: '«{name}» действует',
        sk_combo: 'Совместный приём', sk_trust: 'Доверие {n}% — шанс, что подхватит', sk_trust_none: 'Доверие неизвестно: шансы пополам',
        sk_combo_ok: '{name} подхватил(а)! ({roll} из {chance})', sk_combo_fail: '{name} не подхватил(а) ({roll}, нужно {chance} или меньше)',
        sk_zoom_in: 'Приблизить', sk_zoom_out: 'Отдалить', sk_zoom_fit: 'Вернуть как было',
        set_intimacy: 'Замечать интимные сцены (нега, следы, ломота…)',
        set_intimacy_hint: 'Работает в том же чтении сцены — без отдельного запроса. Нужно «Авто-обновление из сюжета».',
        intimacy_toast: 'После ночи с {name}:', intimacy_toast_anon: 'После интимной сцены:',
        set_ppill: 'Принимаю противозачаточные', set_pend: 'Беременность закончилась', p_end_done: 'Беременность закончилась; цикл начинается заново.', p_prot: 'Защита: {what}', w_condom: 'презерватив', w_pill: 'таблетки', w_story: 'предохранялись по сюжету', condom_bag: 'Использован презерватив из твоего рюкзака.',
        sec_body: 'Твоё тело', set_psex: 'Твоё тело:', psex_none: '— не указано —', psex_f: 'женское', psex_m: 'мужское', psex_x: 'другое',
        set_pcycle: 'Менструальный цикл (бросается один раз)', set_ppreg: 'Шанс беременности после интимной сцены', set_phide: 'Скрывать, пока нет задержки',
        set_pday: 'Сегодня день цикла', set_pevery: 'Без даты Scene Card: новый день каждые N ответов', set_preroll: 'Бросить заново',
        p_rolls: 'Цикл {len} дн., месячные {per} дн., {pain}; {fert} (кубик {r})', p_fert_y: 'может иметь детей', p_fert_n: 'не может иметь детей',
        pain0: 'без боли', pain1: 'слабые спазмы', pain2: 'спазмы', pain3: 'сильные спазмы',
        lbl_cycle: 'Цикл', cyc_day: 'день {d} из {n}', ph_period: 'Месячные', ph_follicular: 'Спокойные дни', ph_ovulation: 'Овуляция', ph_luteal: 'Вторая половина', ph_pms: 'Перед месячными',
        late_n: 'Задержка · {n} дн.', preg_w: 'Беременность · {w} нед.',
        eff_period: 'Месячные', eff_period_d: ['неудобно, не больше', 'слабые спазмы', 'спазмы — трудно сосредоточиться', 'сильные спазмы — хочется лечь'],
        eff_pms: 'Перед месячными', eff_pms_d: 'обидчивее обычного, тянет на сладкое',
        eff_ovu: 'Овуляция', eff_ovu_d: 'больше сил, тянет к близости',
        eff_late: 'Задержка', eff_late_d: 'месячные не пришли уже {n} дн.',
        eff_preg: 'Беременность', eff_preg_d: 'около {w} нед. — быстрее устаёт, иногда подташнивает',
        eff_preg_t1: 'около {w} нед. — подташнивает по утрам, тянет на странное', eff_preg_t2: 'около {w} нед. — живот уже начинает быть заметен', eff_preg_t3: 'около {w} нед. — тяжело, быстро устаёт, ноет спина', eff_preg_term: '{w} нед. — срок подошёл, первые схватки то приходят, то отпускают',
        eff_baby: 'Ночи с малышом', eff_baby_d: 'новорождённый не даёт спать по ночам — не высыпаешься'
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
    if (!settings.skillTrees || typeof settings.skillTrees !== 'object' || Array.isArray(settings.skillTrees)) settings.skillTrees = {};
    Object.keys(settings.skillTrees).forEach(k => { if (k === '__proto__' || k === 'constructor' || k === 'prototype') delete settings.skillTrees[k]; });
    settings.skillDepth = Math.max(0, Math.min(50, Math.round(Number(settings.skillDepth)))); if (!Number.isFinite(settings.skillDepth)) settings.skillDepth = 2;
    settings.skillBranches = [2, 3, 4, 5, 6].includes(Number(settings.skillBranches)) ? Number(settings.skillBranches) : 2;
    ['skillClassesOn', 'skillScanCard', 'skillScanLore'].forEach(k => { if (typeof settings[k] !== 'boolean') settings[k] = true; });
    ['skillPrompt', 'skillUseLine', 'skillComboLine', 'skillClassPrompt'].forEach(k => { if (typeof settings[k] !== 'string') settings[k] = ''; });
    if (!settings.skillClasses || typeof settings.skillClasses !== 'object' || Array.isArray(settings.skillClasses)) settings.skillClasses = {};
    Object.keys(settings.skillClasses).forEach(k => { if (k === '__proto__' || k === 'constructor' || k === 'prototype') delete settings.skillClasses[k]; });
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
    turnMsgRef = null; turnInFlight = null;
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
    if (state.turn) { const m = (getContext().chat || [])[state.turn.id]; turnMsgRef = m && !m.is_user && !m.is_system ? m : null; }
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
            lastMsg.extra.rpg_vitals_checkpoint = bareState(state);
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
const XP_PER_REPLY_MAX = 50;
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
/* Similar effects: the same name, or one name the start of the other ("Sore" / "Soreness"), of the same
   kind. Effects tied to something (worn gear, the cycle) are never merged. */
function effKey(x) { return String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function similarEff(a, b) {
    const x = effKey(a), y = effKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    try { if (window.RPG && window.RPG.match && window.RPG.match.same && window.RPG.match.same(x, y)) return true; } catch (e) { /* no matcher */ }
    const [s0, l0] = x.length <= y.length ? [x, y] : [y, x];
    return s0.length >= 4 && l0.startsWith(s0);
}
function addBuff(b) {
    if (!b || !b.name) return null;
    // a second one of the same: it stacks — ×N, the longer of the two durations, the newest description
    if (settings.stackEffects && !b.tag && state && Array.isArray(state.buffs)) {
        const kind = b.kind === 'debuff' ? 'debuff' : 'buff';
        const hit = state.buffs.find(x => !x.tag && (x.kind === 'debuff' ? 'debuff' : 'buff') === kind && similarEff(x.name, b.name));
        if (hit) {
            hit.count = (hit.count || 1) + 1;
            const nd = (typeof b.duration === 'number' && b.duration > 0) ? Math.round(b.duration) : null;
            if (hit.duration != null) hit.duration = nd == null && !settings.autoExpire ? null : Math.max(hit.duration, nd == null ? hit.duration : nd);
            if (b.effect) hit.effect = String(b.effect);
            if (b.src === 'intimacy') hit.src = 'intimacy';
            saveState(); renderPanel(); buildInjection();
            return hit;
        }
    }
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
        tag: b.tag ? String(b.tag) : undefined, // optional owner tag (e.g. "eq:weapon") for later removal
        src: b.src === 'intimacy' ? 'intimacy' : undefined   // where it came from: shown with its own little mark, fades like any other
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

/* ---- the player's own cycle ----
   For a woman player who switched it on. Rolled once per persona and kept for good; the day
   comes from the Scene Card's date when there is one, from the number of replies when not.
   What it does is told through ordinary effects (a sticky "cycle" tag), so the card shows
   it and the main model hears of it the way it hears of every other effect. */
function tArr(key) { const L = settings.language === 'ru' ? 'ru' : 'en'; const v = (I18N[L] || I18N.en)[key]; return Array.isArray(v) ? v : (I18N.en[key] || []); }
function vd100() { return 1 + Math.floor(Math.random() * 100); }
function personaKey() { return String(playerName() || 'User').trim().toLowerCase(); }
function rollPlayerTraits() {
    const r = { fert: vd100(), len: vd100(), period: vd100(), pain: vd100() };
    return {
        fertile: r.fert > 12,
        len: 25 + Math.floor((r.len - 1) / 100 * 9),
        period: 3 + Math.floor((r.period - 1) / 100 * 5),
        pain: r.pain <= 20 ? 0 : r.pain <= 62 ? 1 : r.pain <= 88 ? 2 : 3,
        rolls: r, at: Date.now()
    };
}
function playerTraits() {
    if (!settings.playerTraits || typeof settings.playerTraits !== 'object') settings.playerTraits = {};
    const k = personaKey();
    if (!settings.playerTraits[k]) { settings.playerTraits[k] = rollPlayerTraits(); saveSettings(); }
    return settings.playerTraits[k];
}
function cycleOn() { return !!(settings.enabled && settings.playerSex === 'f' && settings.playerCycle); }
function cycleState() {
    if (!state) return null;
    if (!state.cycle || typeof state.cycle !== 'object') {
        const tr = playerTraits();
        state.cycle = { day: 1, dateKey: '', tick: 0, start: 1 - Math.floor(Math.random() * tr.len), preg: null, turn: 0, lastIntim: -99 };
    }
    return state.cycle;
}
function playerCycleInfo() {
    if (!cycleOn()) return null;
    const tr = playerTraits(), c = cycleState();
    if (!c) return null;
    const len = Math.max(21, Math.min(40, tr.len || 28)), per = Math.max(2, Math.min(9, tr.period || 5));
    if (c.preg) {
        // counted on the pregnancy's own days (gd), a story day adding the Character tab's speed of them
        const expect = c.start + len * Math.max(1, Math.ceil((c.preg.day - c.start + 1) / len));
        const gd = pregDays(c);
        if (!Number.isFinite(c.preg.due)) c.preg.due = 266 + Math.round((vd100() - 50) / 5);   // about forty weeks, rolled once
        const late = Math.max(0, Math.floor(gd - (expect - c.preg.day)));
        const weeks = Math.max(1, Math.floor(gd / 7) + 2);
        const trim = weeks <= 13 ? 1 : weeks <= 27 ? 2 : 3;
        return { preg: true, late, weeks, trim, gd, due: c.preg.due, term: gd >= c.preg.due, known: !settings.playerHidePreg || late >= 14 || weeks >= 14, len, per };
    }
    const cd = ((((c.day - c.start) % len) + len) % len) + 1;
    const ovu = len - 14;
    let phase = 'follicular';
    if (cd <= per) phase = 'period';
    else if (cd >= ovu - 1 && cd <= ovu + 1) phase = 'ovulation';
    else if (cd >= len - 3) phase = 'pms';
    else if (cd > ovu + 1) phase = 'luteal';
    return { preg: false, cd, len, per, phase, ovu, fertile: cd >= ovu - 5 && cd <= ovu + 1, pain: tr.pain || 0 };
}
/* the pregnancy's days and speed: the speed is the Character tab's (RPG Status Bar + Bonds) — one
   story day is one day, a week or a month of the pregnancy; without it, one day */
function pregSpeedNow() {
    try { const b = window.RPG && window.RPG.body; const v = b && b.available && b.pregSpeed ? +b.pregSpeed() : 1; return v === 7 || v === 30 ? v : 1; } catch (e) { return 1; }
}
function pregDays(c) {
    const p = c.preg;
    if (!Number.isFinite(p.gd)) { p.gd = Math.max(0, c.day - p.day); p.gdDay = c.day; }   // a pregnancy from before: its days so far
    if (!Number.isFinite(p.gdDay)) p.gdDay = c.day;
    if (c.day !== p.gdDay) { p.gd = Math.max(0, p.gd + (c.day - p.gdDay) * pregSpeedNow()); p.gdDay = c.day; }
    return p.gd;
}
function nextDay(c) {
    c.day += 1;
    if (c.preg) pregDays(c);
}
// the speed is about to change in the Character tab: what has passed stays counted at the old one
window.addEventListener('rpg:preg-speed', () => { try { syncChat(); const c = state && state.cycle; if (c && c.preg) { pregDays(c); saveState(); } } catch (e) { /* later */ } });
// her term: the birth goes to the Character tab's clipping (once it takes it)
function checkPlayerTerm() {
    const c = cycleState(); if (!c || !c.preg || c.preg.labor) return;
    const ci = playerCycleInfo(); if (!ci || !ci.preg || !ci.term) return;
    try {
        const b = window.RPG && window.RPG.body;
        if (b && b.available && b.labor && b.labor({ mother: playerName(), father: c.preg.father || (c.lastRoll && c.lastRoll.with) || '', weeks: ci.weeks })) { c.preg.labor = true; saveState(); }
    } catch (e) { /* no Character tab */ }
}
// a newborn nobody else looks after: the player does not sleep either (the Character tab knows the children)
function syncBabyEffect() {
    if (!state) return;
    let want = false;
    try { const b = window.RPG && window.RPG.body; want = !!(settings.enabled && b && b.available && b.babyNights && b.babyNights(playerName())); } catch (e) { want = false; }
    const cur = state.buffs.find(b => b.tag === 'baby');
    if (!!cur === want) return;
    if (cur) { state.buffs = state.buffs.filter(b => b.tag !== 'baby'); saveState(); renderPanel(); buildInjection(); }
    else addBuff({ name: t('eff_baby'), effect: t('eff_baby_d'), kind: 'debuff', tag: 'baby' });
}
// the sticky effect of the day: replaced when the phase changes, gone when there is nothing to say
function syncCycleEffect() {
    if (!state) return;
    const ci = playerCycleInfo();
    let want = null;
    if (ci) {
        if (ci.preg) {
            if (ci.known) want = { name: t('eff_preg'), effect: ci.term ? t('eff_preg_term', { w: ci.weeks }) : ci.weeks >= 5 ? t('eff_preg_t' + ci.trim, { w: ci.weeks }) : t('eff_preg_d', { w: ci.weeks }), kind: 'buff' };
            else if (ci.late >= 1) want = { name: t('eff_late'), effect: t('eff_late_d', { n: ci.late }), kind: 'debuff' };
        } else if (ci.phase === 'period') want = { name: t('eff_period'), effect: tArr('eff_period_d')[ci.pain] || '', kind: 'debuff' };
        else if (ci.phase === 'pms') want = { name: t('eff_pms'), effect: t('eff_pms_d'), kind: 'debuff' };
        else if (ci.phase === 'ovulation') want = { name: t('eff_ovu'), effect: t('eff_ovu_d'), kind: 'buff' };
    }
    const cur = state.buffs.find(b => b.tag === 'cycle');
    const same = cur && want && cur.name === want.name && cur.effect === want.effect && cur.kind === want.kind;
    if (same || (!cur && !want)) return;
    if (cur) state.buffs = state.buffs.filter(b => b.tag !== 'cycle');
    if (want) addBuff(Object.assign(want, { tag: 'cycle' }));   // tagged: it stays until the phase ends
    else { saveState(); renderPanel(); buildInjection(); }
}
// one bot reply: the day moves on when the Scene Card's date does, or every N replies without it
function cycleTick() {
    if (!cycleOn()) { if (state && state.buffs.some(b => b.tag === 'cycle')) { state.buffs = state.buffs.filter(b => b.tag !== 'cycle'); saveState(); renderPanel(); buildInjection(); } return; }
    const c = cycleState(); if (!c) return;
    c.turn += 1;
    let sc = null;
    try { sc = window.RPG && window.RPG.scene && window.RPG.scene.available && window.RPG.scene.get ? window.RPG.scene.get() : null; } catch (e) { sc = null; }
    const dk = sc && sc.date ? String(sc.date).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
    if (dk) {
        if (c.dateKey && dk !== c.dateKey) nextDay(c);
        c.dateKey = dk;
    } else {
        c.tick += 1;
        if (c.tick >= Math.max(4, parseInt(settings.cycleDayEvery, 10) || 30)) { c.tick = 0; nextDay(c); }
    }
    saveState();
    syncCycleEffect();
    checkPlayerTerm();
}
// a night together: one roll, by the day of her cycle (Vitals' own scene reading and Bonds both report it)
function onPlayerIntimacy(detail) {
    try {
        if (!detail || detail.level !== 'sex' || !cycleOn() || !settings.playerPregnancy) return;
        if (detail.chatId && detail.chatId !== currentChatId) return;
        const c = cycleState(); if (!c || c.preg) return;
        if (c.turn - c.lastIntim <= 2) return;
        c.lastIntim = c.turn;
        const tr = playerTraits();
        // a woman partner (as the Character tab knows her): no child from this night
        try { const pt = ((extension_settings.rpg_body || {}).traits || {})[String(detail.with || '').trim().toLowerCase()]; if (pt && pt.sex === 'f') { saveState(); return; } } catch (e) { /* not known */ }
        if (!tr.fertile) { saveState(); return; }
        const ci = playerCycleInfo();
        let chance = !ci || ci.preg ? 0 : ci.phase === 'period' ? 0.5 : (ci.cd === ci.ovu - 1 || ci.cd === ci.ovu) ? 30 : ci.fertile ? 15 : 1;
        // protection: the scene showed it, a condom (the partner's pocket or your backpack — used once), the pill
        const what = [];
        if (detail.protected) { chance *= 0.1; what.push(t('w_story')); }
        else if (playerCondom(detail)) { chance *= 0.1; what.push(t('w_condom')); }
        if (settings.playerPill) { chance *= 0.02; what.push(t('w_pill')); }
        chance = Math.round(chance * 100) / 100;
        const roll = vd100();
        if (roll <= chance) c.preg = { day: c.day, roll, chance, gd: 0, gdDay: c.day, father: String(detail.with || '') };
        c.lastRoll = { roll, chance, with: String(detail.with || ''), day: c.day, protection: what };
        saveState();
        syncCycleEffect();
    } catch (e) { console.warn('[RPG Vitals] cycle', e); }
}
window.addEventListener('rpg:intimacy', e => { syncChat(); onPlayerIntimacy(e && e.detail); });
const CONDOM_RE = /презерватив|кондом|condom|rubber/i;
function playerCondom(detail) {
    if (detail.condomUsed) return true;
    try {
        // the partner's pocket first (RPG Status Bar + Bonds' Character tab), then the player's backpack
        const body = window.RPG && window.RPG.body;
        if (body && body.available && body.useCondom && detail.with && body.useCondom(detail, detail.with)) return true;
        const inv = window.RPG && window.RPG.inventory;
        const hit = inv && inv.available ? (inv.list() || []).find(x => CONDOM_RE.test(x.name)) : null;
        if (hit) { inv.remove(hit.id); detail.condomUsed = true; toastr.info(t('condom_bag')); return true; }
    } catch (e) { /* no backpack */ }
    return false;
}
// how: undefined — the story ended it; 'birth' — the Character tab delivered the baby; 'manual' — the button
function endPlayerPregnancy(how) {
    const c = cycleState(); if (!c || !c.preg) return;
    const quiet = how === 'birth';
    try {
        const b = window.RPG && window.RPG.body;
        // the story ended it while the birth was waiting in the Character tab: that was the birth (the child is made there)
        if (!how && b && b.available && b.laborPending && b.laborPending() && b.born()) return;
        // ended by hand: the waiting clipping goes too
        if (how === 'manual' && b && b.available && b.cancelLabor) b.cancelLabor();
    } catch (e) { /* no Character tab */ }
    c.preg = null; c.start = c.day;
    saveState(); syncCycleEffect();
    if (!quiet) toastr.info(t('p_end_done'));
}
// the Character tab delivered the player's baby
window.addEventListener('rpg:birth', e => {
    try { const d = e && e.detail; if (!d || !d.player) return; syncChat(); if (d.chatId && d.chatId !== currentChatId) return; endPlayerPregnancy('birth'); } catch (err) { console.warn('[RPG Vitals] birth', err); }
});

// ---- combat / enemies ----
/* Another extension (the Map's trials) can ask for the combat scan while a fight lasts. It is held
   only in memory, per asker, and never touches the saved checkbox: when the last one lets go,
   the scan is back to what you set. */
const combatHolds = new Set();
function combatScanOn() { return !!settings.combatAuto || combatHolds.size > 0; }
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

async function callAI(systemPrompt, userPrompt, opts) {
    if (!apiKey()) throw new Error('API key is not set!');
    const endpointUrl = apiUrl() + '/chat/completions';
    const tries = opts && opts.once ? 1 : 2;   // a long answer is not asked for twice behind the caller's back
    for (let i = 0; i < tries; i++) {
        try {
            const response = await fetch(endpointUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey().trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: apiModel(),
                    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                    temperature: settings.temperature,
                    // a long answer (the skill tree) is given room: a local server otherwise stops at its own short default
                    ...(opts && opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
                    ...(wantsStrictJson(endpointUrl) ? { response_format: { type: 'json_object' } } : {})
                })
            });
            if (response.status === 429 && i === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const ch0 = (data.choices && data.choices[0]) || {};
            const msg0 = ch0.message || {};
            // a thinking model may leave "content" empty and put everything in its reasoning; a plain completion server answers in "text"
            const content = String(msg0.content || ch0.text || msg0.reasoning_content || msg0.reasoning || '').trim();
            if (opts) { opts.raw = content; opts.finish = String(ch0.finish_reason || ''); opts.usage = data.usage && typeof data.usage === 'object' ? data.usage : null; }
            if (opts && opts.lenient) return skLooseJson(content);   // not JSON at all: null, the caller says why
            const m = content.match(/\{[\s\S]*\}/);
            return JSON.parse(m ? m[0] : content);
        } catch (e) { if (i === tries - 1) throw e; }
    }
}
const EAT_RE = /\b(eat|eats|eating|ate|drink|drinks|drinking|drank|bite|bites|chew|chews|swallow|swallows|sip|sips|munch|devour|feast|gulp|nibble)\b|съе(л|ла|сть|ем|шь)|\bест\b|поел|перекус|откус|кус(аю|нул)|жу(ю|ёт)|пь(ю|ёт)|пил[аои]?\b|выпи|глот|хлебн|заеда/i;
function mentionsEating(text) { return EAT_RE.test(String(text || '')); }
// healing / rest / mana actions the PLAYER may narrate about themselves
const CARE_RE = /\b(bandag|patch(ed|es|ing)? up|dress(ed|ing)? the wound|tend(ed|ing)?|stitch|heal|rest|sleep|slept|nap|recover|recuperat|meditat|catch (my|her|his) breath|first aid|salve|ointment|potion|drink.*potion)\b|перевяз|перевязк|перевязал|обработал.*ран|заклеил|зашил|бинт|лечу|лечит|лечен|исцел|отдых|отдохн|поспал|вздремн|передохн|восстанавлив|отлежал|медитир|отдышал|мазь|зель[ея]|снадоб/i;
function mentionsCare(text) { return CARE_RE.test(String(text || '')); }

/* Asks one question and expects one word. Deliberately tiny: a short prompt, a short
   answer, and no schema to go wrong. If the model is unreachable or answers something
   unexpected the damage is allowed through, because refusing to ever apply damage
   would be a worse bug than the one being fixed. */
async function whoseHurt(text, who, others) {
    try {
        const sys = `In the passage below, WHO was physically hurt?
"${who}" is the player. ${others.map(n => `"${n}"`).join(', ')} ${others.length > 1 ? 'are' : 'is'} someone else.
Answer with ONE word and nothing else:
player  — if "${who}" personally took the injury
other   — if only someone else was hurt
none    — if nobody was actually hurt in this passage
Watching, hearing about, or fearing an injury is not being hurt.`;
        const r = await callAI(sys, String(text || '').slice(0, 1200));
        const a = String((r && (r.answer ?? r.who ?? r.result)) ?? r ?? '').toLowerCase();
        if (/\bother\b/.test(a)) return 'other';
        if (/\bnone\b/.test(a)) return 'other';       // nobody hurt means not the player either
        if (/\bplayer\b/.test(a)) return 'player';
        return 'player';                               // unreadable answer: leave the original call alone
    } catch (e) {
        console.warn('[RPG Vitals] whose-hurt check failed, keeping the damage:', e);
        return 'player';
    }
}

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
        if (vitalsBusy !== false && vitalsBusy === turnEpoch) return; // never stack analyses — this is what caused freezes after eating
        const myEpoch = turnEpoch; vitalsBusy = myEpoch;
        try {
            const whoS = getContext().name1 || 'the player';
            const askSat = settings.hungerEnabled ? `\n"satiety_delta": satiety GAINED by eating/drinking THIS message — POSITIVE 0..40 (snack ~10, meal ~30, drink ~5-15), else 0.` : '';
            const askMana = settings.manaEnabled ? `\n"mana_delta": mana RECOVERED by resting/meditating/a potion THIS message — POSITIVE 0..40, else 0.` : '';
            const askFat = settings.fatigueEnabled ? `\n"fatigue_delta": NEGATIVE if they rested/slept (recovered), 0 otherwise.` : '';
            const sysS = `The player "${whoS}" (currently ${state.hp}/${state.maxHp} HP) just narrated an action about THEMSELVES. Report only self-care they actually did. Giving food or drink to someone else is not eating: satiety 0 then.
"hp_delta": HP RECOVERED by tending a wound / first aid / resting / a healing potion THIS message — a POSITIVE, REALISTIC number. Basic first aid or a bandage restores only a LITTLE (about 5-15); real rest or a good remedy more (15-35); a potent healing potion most. It must NEVER fully heal from one ordinary bandage. 0 if no real healing happened.${askSat}${askMana}${askFat}
Optionally "add_effects": one short effect if clearly granted (e.g. "Bandaged", "Rested"), else empty.
Write effect names in ${genLang()}. Output strictly JSON: {"hp_delta":0${settings.hungerEnabled ? ',"satiety_delta":0' : ''}${settings.manaEnabled ? ',"mana_delta":0' : ''}${settings.fatigueEnabled ? ',"fatigue_delta":0' : ''},"add_effects":[]}`;
            const resS = await callAI(sysS, String(msg.mes).slice(0, 1500));
            if (!ownsChat(myChat) || myEpoch !== turnEpoch) return;   // chat changed, or the turn was swiped, during the request
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
        } catch (e) { /* silent */ } finally { if (vitalsBusy === myEpoch) vitalsBusy = false; }
        return;
    }
    if (vitalsBusy !== false && vitalsBusy === turnEpoch) return; // don't run the story scan while another analysis is in flight
    const myEpoch = turnEpoch; vitalsBusy = myEpoch;
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
        if (settings.hungerEnabled) { fields += ',"satiety_delta":0'; rules += `\n- "satiety_delta": +N when "${who}" EATS or DRINKS this message (fuller: a snack ~10, a meal ~30, a drink ~5-15). Only "${who}"'s OWN eating or drinking counts: someone else eating — even food "${who}" gave them — is 0. Eating or drinking is ALWAYS positive. Use a negative number ONLY if the text explicitly shows a long stretch with no food at all. Otherwise 0.`; }
        if (settings.manaEnabled) { fields += ',"mana_delta":0'; rules += `\n- "mana_delta": mana "${who}" spent (negative, e.g. casting/using magic) or recovered (positive, e.g. rest/potion/meditation) THIS message.`; }
        if (settings.fatigueEnabled) { fields += ',"fatigue_delta":0'; rules += `\n- "fatigue_delta": how much MORE tired "${who}" got (positive: hard exertion, fighting, sprinting, no sleep) or how much they recovered (negative: rest/sleep) THIS message.`; }
        if (settings.levelEnabled) { fields += ',"xp_delta":0'; rules += `\n- "xp_delta": experience for a real achievement by "${who}" THIS message (finishing a quest, a big victory, a breakthrough) — usually 0, occasionally 10–40. Do NOT award xp just for talking.`; }
        /* Intimate scenes leave traces on the body too — read here, in the same request, never in
           one of their own. The effects are ordinary effects with a duration; the scene itself is
           reported once ("intimacy" + with whom) so other modules (Bonds) can react to it. */
        const askIntimacy = !!settings.intimacyEnabled;
        const pregNow = (() => { try { const ci = playerCycleInfo(); return !!(ci && ci.preg); } catch (e) { return false; } })();
        if (pregNow) { fields += ',"pregnancy_ended":false'; rules += `\n- "pregnancy_ended": true only if THIS message clearly ends "${who}"'s pregnancy (a birth, a miscarriage, an abortion).`; }
        if (askIntimacy) { fields += ',"intimacy":"none","intimacy_with":"","intimacy_protected":false'; rules += `\n- "intimacy": what intimate contact "${who}" personally had THIS message — "none"; "romantic" (a real kiss, a long embrace, sleeping in someone's arms); or "sex" (making love / a sexual scene, including its aftermath the morning after). Talking about it or wanting it is "none". "intimacy_with": the partner's name, or "". "intimacy_protected": true only if the scene clearly shows a condom or other contraception used.\n- When "intimacy" is not "none", add 1–2 fitting effects to "add_effects", each with "src":"intimacy" and a duration of 3–12 messages: a buff for what it gave (afterglow, calm, warmth, a good mood, being well rested) and/or a debuff for what it left (a visible mark such as a hickey, a bite mark or scratches; soreness; a sleepless night; tousled hair). The description says in one short sentence how it feels or how it shows to others. Tasteful, never explicit. Do not add one that is already among the current effects.`; }

        /* Everyone in the scene has a body, and the model was being asked to watch one
           of them while reading about all of them. A single line naming the partner was
           not enough: in a group chat, or when an NPC turns up mid-scene, the wounds of
           whoever was described most vividly ended up on the player.

           The rule is now stated as a rule, with the other names listed by name, and
           with the one case that caused most of it spelled out — the character being
           hurt while the player only watches. */
        const others = (() => {
            try {
                const ctx = getContext();
                const names = new Set();
                if (partner) names.add(partner);
                (ctx.chat || []).slice(-12).forEach(m => {
                    if (m && !m.is_user && !m.is_system && m.name && m.name !== who) names.add(m.name);
                });
                return [...names].slice(0, 8);
            } catch (e) { return partner ? [partner] : []; }
        })();
        const notMe = others.length
            ? `\n\nWHOSE BODY THIS IS ABOUT — the single most important rule:
"${who}" is the player. ${others.map(n => `"${n}"`).join(', ')} ${others.length > 1 ? 'are' : 'is'} NOT "${who}".
Report ONLY what happened to "${who}"'s own body. If someone else is struck, bleeding, poisoned, exhausted or healed, that is THEIR body and NOT the player's — return 0 for it.
Watching someone get hurt is not being hurt. Being told about an injury is not having one. Fearing a blow is not taking one.
If the message never makes clear that "${who}" personally was affected, return zeros. When in doubt it is always zeros.`
            : `\n\nReport ONLY what happened to "${who}"'s own body. Anyone else's injuries are not the player's — return 0 for those. When in doubt, return zeros.`;

        const sys = `You track the physical state of "${who}" (the player/user) in a roleplay.${notMe}
Read ONLY the latest scene text and report what actually changed for "${who}" in THIS message.
Be conservative: most messages change nothing — then return zeros and empty arrays. Only react to clear events (taking a hit, healing/resting, eating/drinking, being poisoned/drunk/blessed/exhausted, an effect ending).
Current HP ${state.hp}/${state.maxHp}${hungerInfo}${manaInfo}${fatigueInfo}${lvlInfo}. Current effects: ${effList}.${rules}
Write any effect names/descriptions in ${genLang()}.
Output strictly JSON: {${fields}}`;
        const res = await callAI(sys, String(msg.mes).slice(0, 2000));
        if (!ownsChat(myChat) || myEpoch !== turnEpoch) return;   // chat changed, or the turn was swiped, during the request
        if (!res) return;
        const notes = [];
        if (typeof res.hp_delta === 'number' && res.hp_delta !== 0) {
            let hpd = res.hp_delta;
            // skip narrative damage ONLY when the combat scan already subtracted damage for
            // this very message; otherwise story wounds (traps, falls, ambush narration)
            // never reached HP at all with combatAuto on
            if (hpd < 0 && combatScanOn() && opts && opts.combatDmg > 0) hpd = 0;

            /* Second line of defence. A prompt is a request, not a guarantee, and the
               one thing worth being sure about is damage: healing the player by mistake
               is a small annoyance, hurting them for someone else's wound ruins the
               scene. So when damage is reported the model is asked once more, plainly,
               whose body it was — and anything short of a clear "the player" is dropped.

               Only for damage, and only when the answer is unambiguous, so the extra
               call is rare and the failure mode is "nothing happens" rather than
               "something wrong happens". */
            if (hpd < 0 && others.length) {
                const verdict = await whoseHurt(msg.mes, who, others);
                if (!ownsChat(myChat) || myEpoch !== turnEpoch) return;
                if (verdict === 'other') {
                    console.log('[RPG Vitals] damage ignored: it belonged to ' + others.join('/'));
                    hpd = 0;
                }
            }

            if (hpd > 0) { heal(hpd); notes.push(`HP +${hpd}`); }
            else if (hpd < 0) { damage(-hpd); notes.push(`HP ${hpd}`); }
        }
        if (settings.hungerEnabled && typeof res.satiety_delta === 'number' && res.satiety_delta !== 0) { setHunger(state.hunger + res.satiety_delta); notes.push(`${t('lbl_satiety')} ${res.satiety_delta > 0 ? '+' : ''}${res.satiety_delta}`); }
        if (settings.manaEnabled && typeof res.mana_delta === 'number' && res.mana_delta !== 0) { addMana(res.mana_delta); notes.push(`${t('mana_word')} ${res.mana_delta > 0 ? '+' : ''}${res.mana_delta}`); }
        if (settings.fatigueEnabled && typeof res.fatigue_delta === 'number' && res.fatigue_delta !== 0) { addFatigue(res.fatigue_delta); notes.push(`${t('fatigue_word')} ${res.fatigue_delta > 0 ? '+' : ''}${res.fatigue_delta}`); }
        // one reply gives at most 50 experience (half a level): a generous answer of the model does not hand out levels
        if (settings.levelEnabled && typeof res.xp_delta === 'number' && res.xp_delta > 0) { const xp = Math.min(XP_PER_REPLY_MAX, Math.round(res.xp_delta)); addXp(xp); notes.push(`${t('xp')} +${xp}`); }
        const intim = askIntimacy ? String(res.intimacy || 'none').toLowerCase() : 'none';
        const intimNotes = [];
        for (const e of (Array.isArray(res.add_effects) ? res.add_effects : [])) {
            if (!e || !e.name) continue;
            const fromIntim = e.src === 'intimacy';
            if (fromIntim && (!askIntimacy || intim === 'none')) continue;   // switched off, or nothing happened: no "marks" out of thin air
            if (fromIntim && state.buffs.some(b => b.name.toLowerCase() === String(e.name).toLowerCase())) continue;   // the same mark twice is one mark
            addBuff(e);
            (fromIntim ? intimNotes : notes).push((e.kind === 'debuff' ? '−' : '+') + escapeHtml(e.name));
        }
        for (const nm of (Array.isArray(res.remove_effects) ? res.remove_effects : [])) { const b = state.buffs.find(x => x.name === nm) || (settings.stackEffects ? state.buffs.find(x => !x.tag && similarEff(x.name, nm)) : null); if (b) removeBuff(b.id); }
        if (notes.length) toastr.info(t('auto_changed') + ' ' + notes.join(', '));
        if (pregNow && (res.pregnancy_ended === true || res.pregnancy_ended === 'true')) endPlayerPregnancy();
        if (askIntimacy && (intim === 'romantic' || intim === 'sex')) {
            const withWhom = String(res.intimacy_with || '').trim().slice(0, 60);
            if (intimNotes.length) toastr.info((withWhom ? t('intimacy_toast', { name: escapeHtml(withWhom) }) : t('intimacy_toast_anon')) + ' ' + intimNotes.join(', '));
            // told once, to whoever listens (RPG Status Bar + Bonds keeps the character's cycle)
            const detail = { level: intim, with: withWhom, messageId, chatId: myChat, at: Date.now(), protected: res.intimacy_protected === true || res.intimacy_protected === 'true' };
            state.lastIntimacy = detail; saveState();
            try { window.dispatchEvent(new CustomEvent('rpg:intimacy', { detail })); } catch (e) { /* nobody listening */ }
        }
    } catch (e) { /* silent: don't disrupt chat on API errors */ } finally { if (vitalsBusy === myEpoch) vitalsBusy = false; }
}
async function analyzeCombat(messageId) {
    if (!settings.enabled || !combatScanOn() || !apiKey() || !state) return 0;
    const myChat = currentChatId;
    const myEpoch = turnEpoch;
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
        if (!ownsChat(myChat) || myEpoch !== turnEpoch) return 0;   // chat changed, or the turn was swiped, during the request
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
        // others that follow the fight (the Map's trials) hear that the foes changed
        try { window.dispatchEvent(new CustomEvent('rpg:vitals-enemies', { detail: { messageId } })); } catch (e) { }
        if (notes.length) toastr.info(t('combat_changed') + ' ' + notes.join(', '));
        return dmgApplied;   // lets the narrative scan know combat already took this message's damage
    } catch (e) { /* silent: never disrupt chat on API errors */ }
    return 0;
}
function tickBuffs(messageId) {
    if (!settings.enabled || !state) return;
    const msg = getContext().chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    try { skillTick(); } catch (e) { console.warn('[RPG Vitals] skills tick', e); }
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
// EXACTLY ONCE — and for the variant that is on screen. Swiping, regenerating or continuing the last
// reply re-fires MESSAGE_RECEIVED for the same message. The state from just before that reply is kept
// (state.turn), so a new variant starts from it instead of stacking on the old variant's changes, and
// each variant's result is kept in its own swipe (message.extra is per swipe in SillyTavern), so
// swiping back to a variant shows its result again without a new request.
function bareState(s) { const c = cloneState(s); delete c.turn; return c; }
function mesKey(msg) {
    const m = String(msg && msg.mes || '');
    let h = 0; for (let i = 0; i < m.length; i++) h = (h * 31 + m.charCodeAt(i)) | 0;
    return `${typeof msg.swipe_id === 'number' ? msg.swipe_id : 0}:${m.length}:${h}`;
}
// What changed from `from` to `to`, laid over `cur`: a swipe moves only what the reply changed, and
// keeps what was done by hand meanwhile (a potion drunk, an effect removed, an edit in GM mode).
// Numbers move by the difference; lists of things with an id gain and lose those things; the rest takes `to`.
function rebase(cur, from, to) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const copy = x => (x && typeof x === 'object') ? JSON.parse(JSON.stringify(x)) : x;
    if (same(from, to)) return cur;
    if (typeof cur === 'number' && typeof from === 'number' && typeof to === 'number') return cur + (to - from);
    const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
    const idOf = x => isObj(x) ? (x.id != null ? 'i:' + x.id : (x.name != null ? 'n:' + x.name : null)) : null;
    if (Array.isArray(cur) && Array.isArray(from) && Array.isArray(to) && [...from, ...to].every(x => idOf(x) != null)) {
        const F = new Map(from.map(x => [idOf(x), x])), T = new Map(to.map(x => [idOf(x), x]));
        let out = cur.filter(x => { const k = idOf(x); return !(k != null && F.has(k) && !T.has(k)); });
        out = out.map(x => { const k = idOf(x); return (k != null && F.has(k) && T.has(k)) ? rebase(x, F.get(k), T.get(k)) : x; });
        for (const [k, x] of T) if (!F.has(k) && !out.some(y => idOf(y) === k)) out.push(copy(x));
        return out;
    }
    if (isObj(cur) && isObj(from) && isObj(to)) {
        if (cur.id != null && from.id != null && cur.id !== from.id) return cur;   // a different thing there now: not the reply's to change
        const out = { ...cur };
        for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
            if (!(k in to)) { delete out[k]; continue; }
            if (!(k in from) || !(k in cur)) { if (!(k in from) || !same(from[k], to[k])) out[k] = copy(to[k]); continue; }
            if (!same(from[k], to[k])) out[k] = rebase(cur[k], from[k], to[k]);
        }
        return out;
    }
    return copy(to);
}
function clampVitals(s) {
    const c = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    s.maxHp = Math.max(1, Number(s.maxHp) || 1);
    s.hp = c(s.hp, 0, s.maxHp); s.hunger = c(s.hunger, 0, 100); s.mana = c(s.mana, 0, 100); s.fatigue = c(s.fatigue, 0, 100);
    s.xp = Math.max(0, Number(s.xp) || 0); s.level = Math.max(1, Number(s.level) || 1);
    s.buffs = (s.buffs || []).filter(b => b && (b.duration == null || b.duration > 0));
    s.buffs.forEach(b => { if (b.count != null && b.count < 1) b.count = 1; });
    s.enemies = (s.enemies || []).filter(e => e && e.hp > 0);
    return s;
}
// move the state from the variant now counted to `target` (the state before the reply, or another variant's result)
function moveTo(target) {
    const turn = state.turn;
    const from = turn && turn.applied ? turn.applied : bareState(state);
    state = clampVitals(normalizeState(rebase(bareState(state), from, cloneState(target))));
    if (turn) { turn.applied = cloneState(target); state.turn = turn; }
    if (currentChatId) settings.chatStates[currentChatId] = state;
    turnEpoch++;
    saveState(); _builtSig = null; renderPanel(); buildInjection();
}
function dropKept(msg) {
    if (msg.extra) delete msg.extra.rpg_vitals_after;
    if (Array.isArray(msg.swipe_info)) msg.swipe_info.forEach(si => { if (si && si.extra) delete si.extra.rpg_vitals_after; });
}
function keepVariantResult(id, key) {
    const msg = getContext().chat[id];
    if (!msg || !state || !state.turn || state.turn.id !== id || mesKey(msg) !== key) return;
    const after = { key, state: bareState(state) };
    state.turn.applied = cloneState(after.state);
    if (!msg.extra) msg.extra = {};
    msg.extra.rpg_vitals_after = after;
    const si = Array.isArray(msg.swipe_info) ? msg.swipe_info[msg.swipe_id] : null;
    if (si && typeof si === 'object') { if (!si.extra) si.extra = {}; si.extra.rpg_vitals_after = cloneState(after); }
    saveState();
}
function onBotMessage(id) {
    syncChat();   // tick/analyze against the chat the message actually belongs to
    const msg = getContext().chat[id];
    if (!msg || msg.is_user || msg.is_system || !state) return;
    const key = mesKey(msg);
    if (turnInFlight && turnInFlight.id === id && turnInFlight.key === key) return;   // a re-entrant fire of the same variant
    const kept = msg.extra && msg.extra.rpg_vitals_after;
    turnPending = false;
    if (state.turn && state.turn.id === id) {
        if (kept && kept.key === key) return;                 // this variant was already counted
        moveTo(state.turn.before);                          // a new variant / regeneration / continuation: start from before the reply
    } else {
        if (msg.rpg_vitals_done === true || (kept && kept.key === key)) return;   // an older reply, already counted
        // the previous reply can no longer be swiped: its kept results go from the chat file
        if (turnMsgRef && turnMsgRef !== msg) dropKept(turnMsgRef);
        state.turn = { id, before: bareState(state), applied: null };
        turnMsgRef = msg;
    }
    msg.rpg_vitals_done = true;
    turnInFlight = { id, key };
    const ep = turnEpoch;
    tickBuffs(id);
    try { cycleTick(); } catch (e) { console.warn('[RPG Vitals] cycle', e); }
    try { syncBabyEffect(); } catch (e) { console.warn('[RPG Vitals] baby', e); }
    if (state.turn) state.turn.applied = bareState(state);   // the ticks are this variant's; the readings add to it when kept
    // combat first: the narrative scan then only skips damage that combat ALREADY took.
    // Previously combatAuto discarded ALL narrative damage — a story wound outside a
    // tracked fight (a trap, a fall, an ambush) left HP untouched ("wounded at HP 99").
    analyzeCombat(id).then(dmg => analyzeMessage(id, { combatDmg: dmg || 0 })).catch(() => analyzeMessage(id))
        .finally(() => {
            if (turnInFlight && turnInFlight.id === id && turnInFlight.key === key) turnInFlight = null;
            if (ep === turnEpoch) keepVariantResult(id, key);
        });
}
// Swiping the last reply. To a variant already counted: show its result. To a new one (it is about to
// be generated): rewind to before the reply, so the generation sees the state the reply started from.
function onSwiped(id) {
    syncChat();
    const msg = getContext().chat[id];
    if (!msg || msg.is_user || msg.is_system || !state || !state.turn || state.turn.id !== id) return;
    turnInFlight = null;
    const kept = msg.extra && msg.extra.rpg_vitals_after;
    const generating = !Array.isArray(msg.swipes) || msg.swipe_id >= msg.swipes.length;
    if (!generating && kept && kept.key === mesKey(msg) && kept.state) { moveTo(kept.state); return; }
    moveTo(state.turn.before);
    turnPending = generating;
    if (!generating) onBotMessage(id);   // an older variant with no kept result: count it now
}
// A generation stopped or failed after the swipe: the variant on screen is an old one, its result comes back.
function onGenerationDone() {
    if (!turnPending) return;
    turnPending = false;
    if (!state || !state.turn) return;
    const msg = getContext().chat[state.turn.id];
    const kept = msg && msg.extra && msg.extra.rpg_vitals_after;
    if (msg && msg === turnMsgRef && kept && kept.state && kept.key === mesKey(msg)) moveTo(kept.state);
}
// The last reply deleted (or removed by "Regenerate"): its consequences go with it.
function onDeleted(len) {
    if (!state || !state.turn || !ownsChat(currentChatId)) return;
    const chat = getContext().chat || [];
    const at = turnMsgRef ? chat.indexOf(turnMsgRef) : -1;
    if (at >= 0) { state.turn.id = at; saveState(); return; }   // an earlier message went: the reply only moved up
    if (!turnMsgRef && !(typeof len === 'number' && len <= state.turn.id)) return;   // can't tell which went: keep it
    {
        moveTo(state.turn.before);
        delete state.turn; turnInFlight = null; turnMsgRef = null;
        saveState();
    }
}
function onUserMessage(id) {
    syncChat();
    const msg = getContext().chat[id];
    if (!msg || msg.rpg_vitals_self_done === true) return;
    if (msg) msg.rpg_vitals_self_done = true;
    analyzeMessage(id, { selfReport: true });
}

// where the blocks go: the top of the prompt (as always), or the chat at their depths
function injPos() { return settings.inChat ? 1 : 2; }
function buildInjection() {
    if (!settings.enabled || !state || settings.injectDepth < 0) {
        setExtensionPrompt(PROMPT_KEY, '', injPos(), 0, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(PROMPT_KEY_STARVE, '', injPos(), 0, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(PROMPT_KEY_COMBAT, '', injPos(), 0, false, extension_prompt_roles.SYSTEM);
        try { setExtensionPrompt(PROMPT_KEY_SKILL, '', 1, 0, false, extension_prompt_roles.SYSTEM); } catch (e) { }
        return;
    }
    try { skillInjection(); } catch (e) { console.warn('[RPG Vitals] skills line', e); }
    let parts = [t('inject_hp', { hp: state.hp, max: state.maxHp })];
    if (settings.levelEnabled) parts.push(t('inject_level', { n: state.level }));
    if (state.buffs.length) {
        const list = state.buffs.map(b => {
            const sign = b.kind === 'debuff' ? '−' : '+';
            const dur = b.duration == null ? '' : ` (${b.duration})`;
            return `${sign}${b.name}${b.count > 1 ? ' ×' + b.count : ''}${b.effect ? ': ' + b.effect : ''}${dur}`;
        }).join('; ');
        parts.push(`${t('inject_effects')}: ${list}`);
        parts.push(t('inject_effects_note'));
    }
    if (settings.hungerEnabled && typeof state.hunger === 'number') parts.push(t('inject_hunger', { h: state.hunger }));
    if (settings.manaEnabled && typeof state.mana === 'number') parts.push(t('inject_mana', { m: state.mana }));
    if (settings.fatigueEnabled && typeof state.fatigue === 'number') parts.push(t('inject_fatigue', { f: state.fatigue }));
    setExtensionPrompt(PROMPT_KEY, `\n[${parts.join('. ')}.]\n`, injPos(), settings.injectDepth, false, extension_prompt_roles.SYSTEM);
    // starving — emphatic note at the very END (depth 0), right before the reply
    const starving = settings.hungerEnabled && state.hunger === 0;
    setExtensionPrompt(PROMPT_KEY_STARVE, starving ? `\n[${t('inject_starving')}.]\n` : '', injPos(), 0, false, extension_prompt_roles.SYSTEM);

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
        setExtensionPrompt(PROMPT_KEY_COMBAT, combatText, injPos(), Math.max(0, d), false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(PROMPT_KEY_COMBAT, '', injPos(), 0, false, extension_prompt_roles.SYSTEM);
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

/* Line-drawn ornaments in the sheet's own ink, never emoji: a pair of wings over the
   title, a small flame for each forgiven mistake, a tick and a cross for the answer. */
const ANG_WINGS = '<svg class="ang-wings" viewBox="0 0 120 34" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M60 26c-5-7-15-11-26-11-9 0-17 3-25 9 7-1 13 0 18 2-6 1-11 3-15 6 8-2 16-2 23 0 9 2 17 0 25-6z"/><path d="M60 26c5-7 15-11 26-11 9 0 17 3 25 9-7-1-13 0-18 2 6 1 11 3 15 6-8-2-16-2-23 0-9 2-17 0-25-6z"/><path d="M38 19c-6 1-11 3-15 6M82 19c6 1 11 3 15 6" opacity=".6"/><circle cx="60" cy="9" r="5.5"/><path d="M60 26v6" opacity=".7"/></svg>';
const ANG_FLAME = '<svg viewBox="0 0 12 16" aria-hidden="true"><path d="M6 1c1 3-2.5 4-2.5 7.5A2.5 2.5 0 0 0 6 11a2.5 2.5 0 0 0 2.5-2.5C8.5 7.4 8 6.6 7.4 6 9.6 7.6 10.5 9.4 10.5 11A4.5 4.5 0 0 1 1.5 11C1.5 7 5 5.5 6 1z"/><path class="wick" d="M6 15v-2"/></svg>';
const ANG_TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const ANG_CROSS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
const ANG_LETTERS = { en: ['A', 'B', 'C', 'D', 'E', 'F'], ru: ['А', 'Б', 'В', 'Г', 'Д', 'Е'] };   // a Russian sheet letters its answers in Russian

function angelRender() {
    let el = document.getElementById('rpg-angel');
    if (!angelState) { if (el) el.remove(); angelDrawn = false; return; }

    if (!el) {
        el = document.createElement('div');
        el.id = 'rpg-angel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        document.body.appendChild(el);
        angelDrawn = false;                      // a fresh card may make its entrance
    }
    el.classList.toggle('ang-quiet', angelDrawn);
    angelDrawn = true;

    const st = angelState;
    const d = st.data;
    const head = (title, name) => `<div class="ang-crest">${ANG_WINGS}</div>
        ${title ? `<div class="ang-title ang-bleed">${escapeHtml(title)}</div>` : ''}
        ${name ? `<div class="ang-name">${escapeHtml(name)}</div>` : ''}`;
    const sheet = (cls, inner) => `<div class="ang-dim"></div>
        <div class="ang-card ${cls}"><i class="ang-corner tl"></i><i class="ang-corner tr"></i><i class="ang-corner bl"></i><i class="ang-corner br"></i>${inner}</div>`;
    const btn = (kind, act, icon, label) => `<button class="ang-btn ${kind}" data-ang="${act}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;

    if (st.loading) {
        el.innerHTML = sheet('ang-wait', `${head(t('angel_dead'), '')}
            <div class="ang-sub">${escapeHtml(t('angel_waiting'))}</div>`);
        return;
    }

    if (st.done === 'win') {
        el.innerHTML = sheet('ang-good', `${head('', d ? d.name : '')}
                ${d && d.onWin ? `<div class="ang-speech">${escapeHtml(d.onWin)}</div>` : ''}
                <div class="ang-verdict">${escapeHtml(t('angel_spared'))}</div>
                <div class="ang-actions">${btn('ok', 'close', 'fa-feather', t('angel_back'))}</div>`);
        angelWire(el);
        return;
    }

    if (st.done === 'again' || st.done === 'lose') {
        const speech = st.done === 'again' ? t('angel_again') : (d && d.onLose ? d.onLose : '');
        el.innerHTML = sheet('ang-lost', `${head(t('angel_dead'), st.done === 'lose' && d ? d.name : '')}
                ${speech ? `<div class="ang-speech">${escapeHtml(speech)}</div>` : ''}
                <div class="ang-actions">
                    ${btn('ghost', 'close', 'fa-hourglass-end', t('angel_stay'))}
                    ${btn('danger', 'new', 'fa-rotate-left', t('angel_restart'))}
                </div>
                <div class="ang-note">${escapeHtml(t('angel_kept'))}</div>`);
        angelWire(el);
        return;
    }

    const q = d.questions[st.idx];
    const left = d.allowed - st.wrong;
    const opts = q.options.map((o, i) => {
        let cls = '', mark = escapeHtml(ANG_LETTERS[settings.language === 'ru' ? 'ru' : 'en'][i] || String(i + 1));
        if (st.answered) {
            if (i === q.answer) { cls = 'right'; mark = ANG_TICK; }
            else if (i === st.picked) { cls = 'wrong'; mark = ANG_CROSS; }
            else cls = 'rest';
        }
        return `<button class="ang-opt ${cls}" data-ang="pick" data-i="${i}" ${st.answered ? 'disabled' : ''}><span class="ang-key">${mark}</span><span class="ang-otext">${escapeHtml(o)}</span></button>`;
    }).join('');
    // where the trial stands: a pip per question, a flame per mistake still forgiven
    const pips = d.questions.map((_, i) => `<i class="${i < st.idx ? 'past' : (i === st.idx ? 'now' : '')}"></i>`).join('');
    const flames = Array.from({ length: d.allowed }, (_, i) => `<span class="ang-flame ${i < left ? 'lit' : 'out'}">${ANG_FLAME}</span>`).join('');
    const last = st.wrong > d.allowed || st.idx + 1 >= d.questions.length;

    el.innerHTML = sheet('', `${head(t('angel_dead'), d.name)}
            ${st.idx === 0 && d.greeting ? `<div class="ang-speech">${escapeHtml(d.greeting)}</div>` : ''}
            <div class="ang-meta">
                <span class="ang-prog"><span class="ang-pips">${pips}</span>${escapeHtml(t('angel_q', { n: st.idx + 1, of: d.questions.length }))}</span>
                <span class="ang-lives ${left <= 0 ? 'last' : ''}"><span class="ang-flames">${flames}</span>${escapeHtml(t('angel_left', { n: Math.max(0, left) }))}</span>
            </div>
            <div class="ang-q">${escapeHtml(q.q)}</div>
            <div class="ang-opts">${opts}</div>
            ${st.answered ? `${q.note ? `<div class="ang-note ${st.lastRight ? 'ok' : 'bad'}">${escapeHtml(q.note)}</div>` : ''}
                <div class="ang-actions">${btn('ok', 'next', last ? 'fa-scale-balanced' : 'fa-arrow-right', last ? t('angel_verdict') : t('angel_next'))}</div>` : ''}`);
    angelWire(el);
    // after an answer the next step gets the focus, so Enter goes on (the answers are not
    // pre-focused: a highlighted first answer reads as one already chosen)
    const focus = st.answered ? el.querySelector('[data-ang="next"]') : null;
    if (focus) try { focus.focus({ preventScroll: true }); } catch (e) { /* old browsers */ }
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
    const buffs = state.buffs.map(b => `${b.id}:${b.kind === 'debuff' ? 'd' : 'b'}:${b.duration == null ? 'x' : 'n'}:${b.effect ? 'e' : ''}:${b.count || 1}:${b.effect || ''}`).join(',');
    const enemies = state.enemies.map(e => `${e.id}:${e.hp}/${e.max}`).join(',');   // grouped rows aggregate hp — any change rebuilds
    return [
        settings.language, !!settings.gmControls, !!settings.skillsEnabled, !!(state && settings.skillsEnabled && myTree() && skPoints()), !!settings.hungerEnabled, !!settings.manaEnabled,
        !!settings.fatigueEnabled, !!settings.levelEnabled, flat,
        state.buffs.length === 0 ? 'empty' : 'has', buffs,
        (settings.gmControls || state.enemies.length) ? 'combat' : 'nocombat', enemies,
        (() => { const ci = playerCycleInfo(); return ci ? (ci.preg ? `p${ci.known ? 'k' : ''}${ci.late}:${ci.weeks}` : `${ci.phase}:${ci.cd}`) : 'nocycle'; })()
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
            const d = body.querySelector(`.vex-s[data-bid="${escapeHtml(b.id)}"] .vex-dur`); if (d) d.textContent = b.duration;
        }
        const efd = body.querySelector(`.vex-efl[data-bid="${escapeHtml(b.id)}"] .vex-efl-d`);
        if (efd) efd.textContent = (b.duration == null ? t('forever') : b.duration);
    }
    for (const e of state.enemies) {
        const row = body.querySelector(`.vex-enemy[data-eid="${escapeHtml(e.id)}"]`); if (!row) continue;
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

    // the player's cycle: a small dial and the phase, on the same paper
    const cycleBlock = (() => {
        const ci = playerCycleInfo();
        if (!ci) return '';
        const FLOWER = '<svg viewBox="0 0 24 24" fill="none" stroke="#b04a6e" stroke-width="1.7"><circle cx="12" cy="12" r="2.4"/><path d="M12 9.6C10.5 6 13.5 6 12 9.6M14.4 12C18 10.5 18 13.5 14.4 12M12 14.4C13.5 18 10.5 18 12 14.4M9.6 12C6 13.5 6 10.5 9.6 12"/></svg>';
        let txt, dial = '';
        if (ci.preg) txt = ci.known ? t('preg_w', { w: ci.weeks }) : ci.late >= 1 ? t('late_n', { n: ci.late }) : t('ph_luteal');
        else { txt = `${t('ph_' + ci.phase)} · ${t('cyc_day', { d: ci.cd, n: ci.len })}${ci.phase === 'period' ? ' · ' + t('pain' + ci.pain) : ''}`; dial = `<span class="vex-cyc-dial" style="--p:${Math.round(ci.cd / ci.len * 100)}"><i>${ci.cd}</i></span>`; }
        return `<div class="vex-vital vex-cycle ph-${ci.preg ? 'preg' : ci.phase}">
            <div class="vex-vlabel"><div class="left">${FLOWER}<span class="vex-k">${escapeHtml(t('lbl_cycle'))}</span></div></div>
            <div class="vex-cyc-row">${dial}<span class="vex-cyc-t">${escapeHtml(txt)}</span></div>
        </div>`;
    })();

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
            return `<div class="vex-s filled ${deb ? 'debuff' : ''}${b.src === 'intimacy' ? ' intim' : ''}" data-bid="${escapeHtml(b.id)}" title="${escapeHtml(b.name + (b.count > 1 ? ' ×' + b.count : '') + (b.effect ? ' — ' + b.effect : ''))}">
                ${deb ? DOWN : UP}
                ${b.count > 1 ? `<span class="vex-stack">×${b.count}</span>` : ''}
                ${b.duration == null ? '' : `<span class="vex-dur">${b.duration}</span>`}
                ${gm ? `<span class="vex-b-del rpg-vit-b-del" data-id="${escapeHtml(b.id)}">✕</span>` : ''}
            </div>`;
        }).join('');
        efflist = `<div class="vex-efflist">` + state.buffs.map(b => `<div class="vex-efl ${b.kind === 'debuff' ? 'debuff' : ''}${b.src === 'intimacy' ? ' intim' : ''}" data-bid="${escapeHtml(b.id)}">
            <span class="vex-efl-n">${b.src === 'intimacy' ? '<i class="fa-solid fa-heart vex-love" aria-hidden="true"></i>' : ''}${escapeHtml(b.name)}${b.count > 1 ? ` <b class="vex-efl-x">×${b.count}</b>` : ''}</span>
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
            return `<div class="vex-enemy" data-eid="${escapeHtml(g.repId)}">
                <div class="rpg-vit-hp-top"><span class="rpg-vit-b-name">${escapeHtml(g.label)}</span><span class="rpg-vit-hp-num"><span class="js-e-hp">${g.hp}/${g.max}${g.atk ? ` · ${escapeHtml(t('enemy_atk_ph'))} ${g.atk}` : ''}</span> <i class="fa-solid fa-xmark rpg-vit-e-del" data-id="${escapeHtml(g.repId)}" title="${escapeHtml(t('remove'))}" style="cursor:pointer;color:var(--sepia);margin-left:6px;"></i></span></div>
                <div class="rpg-vit-bar-wrap"><div class="rpg-vit-bar" style="width:${epct}%; background:#b0432f;"></div></div>
                ${gm ? `<div class="vex-ctrl">
                    <button class="rpg-vit-btn ok rpg-vit-atk" data-id="${escapeHtml(g.repId)}"><i class="fa-solid fa-gavel"></i> ${escapeHtml(t('attack'))}</button>
                    <button class="rpg-vit-btn danger rpg-vit-ehit" data-id="${escapeHtml(g.repId)}"><i class="fa-solid fa-burst"></i> ${escapeHtml(t('enemy_hit'))}</button>
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
            ${settings.skillsEnabled ? `<button class="vex-tree" aria-label="${escapeHtml(t('sk_tree'))}" title="${escapeHtml(t('sk_tree'))}">🌿${state && skPoints() && myTree() ? '<i class="vex-tree-pt"></i>' : ''}</button>` : ''}
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
        ${cycleBlock}
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
    body.find('.vex-tree').off('click').on('click', () => openTreeWin());
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
    // open groups in frames, with an emoji each — as RPG Map, Character Lens and Living Scene have them
    const sub = (title, body) => `
            <div class="rpg-vit-sub">
                <div class="rpg-vit-subhead">${title}</div>${body}
            </div>`;
    const num = (label, id, attrs) => `<div class="rpg-vit-srow"><label for="${id}">${label}</label><input type="number" id="${id}" class="text_pole" ${attrs}></div>`;
    const chk = (id, label, extra = '') => `<label class="checkbox_label"${extra}><input type="checkbox" id="${id}"> <span>${label}</span></label>`;
    return `
<div class="extension_settings rpg-vit-settings">
    <div class="inline-drawer">
        <div class="rpg-vit-toggle inline-drawer-header" style="cursor: pointer;">
            <b><i class="fa-solid fa-heart-pulse"></i> ${t('set_title')}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none; padding-top: 6px;">
            <div class="rpg-vit-top">
                ${chk('rpg-vit-enabled', t('set_enable'))}
                <select id="rpg-vit-lang" class="text_pole" title="${escapeHtml(t('set_lang'))}" aria-label="${escapeHtml(t('set_lang'))}">
                    <option value="en">English</option>
                    <option value="ru">Русский</option>
                </select>
            </div>
            ${sub(`🔌 ${t('sec_api')}`, `
                <input type="text" id="rpg-vit-url" class="text_pole" placeholder="${escapeHtml(t('set_url'))} https://openrouter.ai/api/v1" aria-label="${escapeHtml(t('set_url'))}">
                <input type="password" id="rpg-vit-key" class="text_pole" placeholder="${escapeHtml(t('set_key'))} sk-..." aria-label="${escapeHtml(t('set_key'))}">
                <input type="text" id="rpg-vit-model" class="text_pole" placeholder="${escapeHtml(t('set_model'))} google/gemma-4-31b-it" aria-label="${escapeHtml(t('set_model'))}">`)}
            ${sub(`❤️ ${t('sec_health')}`, `
                ${num(t('set_maxhp'), 'rpg-vit-maxhp', 'min="1"')}
                ${num(t('set_depth'), 'rpg-vit-depth', 'min="0"')}
                ${chk('rpg-vit-inchat', t('set_inchat'))}
                ${chk('rpg-vit-stack', t('set_stack'))}
                ${chk('rpg-vit-autoexpire', t('set_autoexpire'))}
                <div class="rpg-vit-in">${num(t('set_autoexpire_max'), 'rpg-vit-autoexpire-max', 'min="1" max="200"')}</div>
                ${chk('rpg-vit-gm', t('set_gm'))}`)}
            ${sub(`🍖 ${t('sec_hunger')}`, `
                ${chk('rpg-vit-hunger-en', t('set_hunger'))}
                <div class="rpg-vit-in">
                    ${num(t('set_hunger_every'), 'rpg-vit-hunger-every', 'min="1"')}
                    ${num(t('set_hunger_amount'), 'rpg-vit-hunger-amt', 'min="1"')}
                    ${num(t('set_starve_dmg'), 'rpg-vit-starve-dmg', 'min="0"')}
                </div>`)}
            ${sub(`🧬 ${t('sec_extra')}`, `
                ${chk('rpg-vit-level-en', t('set_level'))}
                ${chk('rpg-vit-mana-en', t('set_mana'))}
                ${chk('rpg-vit-fatigue-en', t('set_fatigue'))}`)}
            ${sub(`🌸 ${t('sec_body')}`, `
                <div class="rpg-vit-srow"><label for="rpg-vit-psex">${t('set_psex')}</label><select id="rpg-vit-psex" class="text_pole">
                    <option value="">${t('psex_none')}</option><option value="f">${t('psex_f')}</option><option value="m">${t('psex_m')}</option><option value="x">${t('psex_x')}</option></select></div>
                <div class="rpg-vit-fem">
                    ${chk('rpg-vit-pcycle', t('set_pcycle'))}
                    <div class="rpg-vit-in">
                        <div class="rpg-vit-note" id="rpg-vit-prolls"></div>
                        ${num(t('set_pday'), 'rpg-vit-pday', 'min="1" max="40"')}
                        ${chk('rpg-vit-ppill', t('set_ppill'))}
                        ${chk('rpg-vit-ppreg', t('set_ppreg'))}
                        <div class="rpg-vit-in">${chk('rpg-vit-phide', t('set_phide'))}</div>
                        <button type="button" class="menu_button rpg-vit-reroll" id="rpg-vit-pend" style="display:none;">${t('set_pend')}</button>
                        ${num(t('set_pevery'), 'rpg-vit-pevery', 'min="4" max="200"')}
                        <button type="button" class="menu_button rpg-vit-reroll" id="rpg-vit-preroll">🎲 ${t('set_preroll')}</button>
                    </div>
                </div>`)}
            ${sub(`🔍 ${t('sec_scan')}`, `
                ${chk('rpg-vit-autodetect', t('set_autodetect'))}
                <div class="rpg-vit-in">
                    ${chk('rpg-vit-intimacy', t('set_intimacy'))}
                    <div class="rpg-vit-note">${t('set_intimacy_hint')}</div>
                </div>`)}
            ${sub(`⚔️ ${t('sec_combat')}`, `
                ${chk('rpg-vit-combat-auto', t('set_combat_auto'))}
                <div class="rpg-vit-in">${num(t('set_combat_scan'), 'rpg-vit-combat-scan', 'min="1" max="10"')}</div>
                ${chk('rpg-vit-combat-inject', t('set_combat_inject'))}
                <div class="rpg-vit-in">${num(t('set_combat_depth'), 'rpg-vit-combat-depth', 'min="0"')}</div>`)}
            ${sub(`🌿 ${t('sec_skills')}`, `
                ${chk('rpg-vit-sk-en', t('set_sk_en'))}
                <div class="rpg-vit-in">
                    ${chk('rpg-vit-sk-trials', t('set_sk_trials'))}
                    ${chk('rpg-vit-sk-classes', t('set_sk_classes'))}
                    <div class="rpg-vit-in">
                        ${chk('rpg-vit-sk-scancard', t('set_sk_scancard'))}
                        ${chk('rpg-vit-sk-scanlore', t('set_sk_scanlore'))}
                    </div>
                    ${num(t('set_sk_depth'), 'rpg-vit-sk-depth', 'min="0" max="50"')}
                    <div class="rpg-vit-srow"><label for="rpg-vit-sk-branches">${t('set_sk_branches')}</label><select id="rpg-vit-sk-branches" class="text_pole">${[2, 3, 4, 5, 6].map(n => `<option value="${n}">${n}</option>`).join('')}</select></div>
                    <div class="inline-drawer rpg-vit-skp">
                        <div class="inline-drawer-toggle inline-drawer-header"><b>📝 ${t('set_sk_prompts')}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
                        <div class="inline-drawer-content" style="display:none;">
                            <div class="rpg-vit-skp-h"><label for="rpg-vit-sk-p-class">${t('set_sk_p_class')}</label><button type="button" class="rpg-vit-sk-reset" data-for="skillClassPrompt" title="${t('set_sk_reset')}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> ${t('set_sk_reset')}</button></div>
                            <textarea id="rpg-vit-sk-p-class" class="text_pole" rows="7"></textarea>
                            <div class="rpg-vit-skp-h"><label for="rpg-vit-sk-p-tree">${t('set_sk_p_tree')}</label><button type="button" class="rpg-vit-sk-reset" data-for="skillPrompt" title="${t('set_sk_reset')}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> ${t('set_sk_reset')}</button></div>
                            <textarea id="rpg-vit-sk-p-tree" class="text_pole" rows="8"></textarea>
                            <div class="rpg-vit-skp-h"><label for="rpg-vit-sk-p-use">${t('set_sk_p_use')}</label><button type="button" class="rpg-vit-sk-reset" data-for="skillUseLine" title="${t('set_sk_reset')}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> ${t('set_sk_reset')}</button></div>
                            <textarea id="rpg-vit-sk-p-use" class="text_pole" rows="3"></textarea>
                            <div class="rpg-vit-skp-h"><label for="rpg-vit-sk-p-combo">${t('set_sk_p_combo')}</label><button type="button" class="rpg-vit-sk-reset" data-for="skillComboLine" title="${t('set_sk_reset')}"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> ${t('set_sk_reset')}</button></div>
                            <textarea id="rpg-vit-sk-p-combo" class="text_pole" rows="3"></textarea>
                        </div>
                    </div>
                </div>`)}
            ${sub(`🕯️ ${t('sec_angel')}`, `
                ${chk('rpg-vit-angel', t('angel_set'))}
                <div class="rpg-vit-note">${t('angel_hint')}</div>
                ${num(t('angel_depth'), 'rpg-vit-angel-depth', 'min="2" max="30" step="1"')}`)}
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
        const here = $('.rpg-vit-settings').first();
        const mark = $('<div class="rpg-vit-mark"></div>').insertBefore(here);   // rebuilt where it was, not at the end of the list
        $('.rpg-vit-settings').remove(); setupUI();
        mark.replaceWith($('.rpg-vit-settings').detach());
        $('.rpg-vit-settings .inline-drawer-content').not('.rpg-vit-skp > .inline-drawer-content').show();   // the panel stays open, the texts for the model stay folded
        $('.rpg-vit-settings .inline-drawer-icon').not('.rpg-vit-skp .inline-drawer-icon').removeClass('down').addClass('up');
        $('#rpg-vit-btn').attr('title', t('btn_title')); $('#rpg-vit-title').text(t('panel_title'));
        renderPanel(); buildInjection();
    });
    $('#rpg-vit-maxhp').val(settings.defaultMaxHp).on('change', function () { settings.defaultMaxHp = Math.max(1, parseInt($(this).val()) || 100); saveSettings(); });
    // the depths only mean something in the chat: at the top of the prompt SillyTavern ignores them
    const depthLock = () => ['#rpg-vit-depth', '#rpg-vit-combat-depth'].forEach(sel => $(sel).css('opacity', settings.inChat ? '' : '0.55').attr('title', settings.inChat ? '' : t('set_depth_off')));
    $('#rpg-vit-inchat').prop('checked', !!settings.inChat).on('change', function () { settings.inChat = this.checked; saveSettings(); depthLock(); buildInjection(); });
    $('#rpg-vit-depth').val(settings.injectDepth).on('change', function () { settings.injectDepth = Math.max(0, parseInt($(this).val()) || 0); $(this).val(settings.injectDepth); saveSettings(); buildInjection(); });
    $('#rpg-vit-hunger-en').prop('checked', !!settings.hungerEnabled).on('change', function () { settings.hungerEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-hunger-every').val(settings.hungerDrainEvery).on('change', function () { settings.hungerDrainEvery = Math.max(1, parseInt($(this).val()) || 3); saveSettings(); });
    $('#rpg-vit-hunger-amt').val(settings.hungerDrainAmount).on('change', function () { settings.hungerDrainAmount = Math.max(1, parseInt($(this).val()) || 5); saveSettings(); });
    $('#rpg-vit-starve-dmg').val(settings.starveDamage).on('change', function () { settings.starveDamage = Math.max(0, parseInt($(this).val()) || 0); saveSettings(); });
    $('#rpg-vit-stack').prop('checked', settings.stackEffects !== false).on('change', function () { settings.stackEffects = this.checked; saveSettings(); });
    $('#rpg-vit-autoexpire').prop('checked', !!settings.autoExpire).on('change', function () { settings.autoExpire = this.checked; saveSettings(); });
    $('#rpg-vit-autoexpire-max').val(settings.autoExpireMax).on('change', function () { settings.autoExpireMax = Math.max(1, parseInt($(this).val()) || 20); saveSettings(); });
    $('#rpg-vit-gm').prop('checked', !!settings.gmControls).on('change', function () { settings.gmControls = this.checked; saveSettings(); renderPanel(); });
    $('#rpg-vit-level-en').prop('checked', !!settings.levelEnabled).on('change', function () { settings.levelEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-mana-en').prop('checked', !!settings.manaEnabled).on('change', function () { settings.manaEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-fatigue-en').prop('checked', !!settings.fatigueEnabled).on('change', function () { settings.fatigueEnabled = this.checked; saveSettings(); renderPanel(); buildInjection(); });
    $('#rpg-vit-angel').prop('checked', !!settings.angelEnabled).on('change', function () { settings.angelEnabled = this.checked; saveSettings(); });
    /* the skill tree */
    const skRefresh = () => { _builtSig = null; renderPanel(); buildInjection(); renderSkillBar(); if (document.getElementById('rpg-sk-win')) renderTreeWin(); };
    $('#rpg-vit-sk-en').prop('checked', !!settings.skillsEnabled).on('change', function () { settings.skillsEnabled = this.checked; saveSettings(); if (!this.checked) closeTreeWin(); skRefresh(); });
    $('#rpg-vit-sk-trials').prop('checked', !!settings.skillsOnlyTrials).on('change', function () { settings.skillsOnlyTrials = this.checked; saveSettings(); skRefresh(); });
    $('#rpg-vit-sk-classes').prop('checked', !!settings.skillClassesOn).on('change', function () { settings.skillClassesOn = this.checked; saveSettings(); skRefresh(); });
    $('#rpg-vit-sk-scancard').prop('checked', !!settings.skillScanCard).on('change', function () { settings.skillScanCard = this.checked; saveSettings(); });
    $('#rpg-vit-sk-scanlore').prop('checked', !!settings.skillScanLore).on('change', function () { settings.skillScanLore = this.checked; saveSettings(); });
    $('#rpg-vit-sk-depth').val(settings.skillDepth).on('change', function () { settings.skillDepth = Math.max(0, Math.min(50, parseInt(this.value, 10) || 0)); this.value = settings.skillDepth; saveSettings(); buildInjection(); });
    $('#rpg-vit-sk-branches').val(String(settings.skillBranches)).on('change', function () { settings.skillBranches = skNum(this.value, 2, 6, 2); this.value = settings.skillBranches; saveSettings(); });
    const SK_DEF = { skillClassPrompt: SKILL_CLASS_DEFAULT, skillPrompt: SKILL_TREE_DEFAULT, skillUseLine: SKILL_USE_DEFAULT, skillComboLine: SKILL_COMBO_DEFAULT };
    const SK_FIELD = { skillClassPrompt: '#rpg-vit-sk-p-class', skillPrompt: '#rpg-vit-sk-p-tree', skillUseLine: '#rpg-vit-sk-p-use', skillComboLine: '#rpg-vit-sk-p-combo' };
    Object.entries(SK_FIELD).forEach(([k, sel]) => $(sel).val(settings[k] || SK_DEF[k]).on('change', function () {
        const v = String(this.value || '').slice(0, 8000); settings[k] = v.trim() === SK_DEF[k].trim() ? '' : v; saveSettings();
    }).on('keydown', e => e.stopPropagation()));
    $('.rpg-vit-sk-reset').on('click', function () { const k = this.dataset.for; if (!SK_FIELD[k]) return; settings[k] = ''; $(SK_FIELD[k]).val(SK_DEF[k]); saveSettings(); });
    $('#rpg-vit-angel-depth').val(settings.angelDepth || 6).on('change', function () {
        settings.angelDepth = Math.max(2, Math.min(30, parseInt(this.value, 10) || 6));
        this.value = settings.angelDepth; saveSettings();
    });
    const intimLock = () => $('#rpg-vit-intimacy').prop('disabled', !settings.autoDetect).closest('.checkbox_label').toggleClass('rpg-vit-off', !settings.autoDetect);
    $('#rpg-vit-autodetect').prop('checked', !!settings.autoDetect).on('change', function () { settings.autoDetect = this.checked; saveSettings(); intimLock(); });
    $('#rpg-vit-intimacy').prop('checked', !!settings.intimacyEnabled).on('change', function () { settings.intimacyEnabled = this.checked; saveSettings(); });
    intimLock();
    // your body: the cycle only for a woman player, and the rolls written out
    const femLock = () => {
        $('.rpg-vit-fem').toggle(settings.playerSex === 'f');
        const tr = settings.playerSex === 'f' ? playerTraits() : null;
        $('#rpg-vit-prolls').text(tr ? t('p_rolls', { len: tr.len, per: tr.period, pain: t('pain' + (tr.pain || 0)), fert: t(tr.fertile ? 'p_fert_y' : 'p_fert_n'), r: tr.rolls ? tr.rolls.fert : '—' }) : '');
        const ci = playerCycleInfo();
        $('#rpg-vit-pday').val(ci && !ci.preg ? ci.cd : '').prop('disabled', !ci || ci.preg);
        $('#rpg-vit-pend').toggle(!!(ci && ci.preg));
    };
    const bodyChanged = () => { saveSettings(); if (state) { syncCycleEffect(); _builtSig = null; renderPanel(); } femLock(); };
    $('#rpg-vit-psex').val(settings.playerSex || '').on('change', function () { settings.playerSex = ['f', 'm', 'x'].includes(this.value) ? this.value : ''; bodyChanged(); });
    $('#rpg-vit-pcycle').prop('checked', !!settings.playerCycle).on('change', function () { settings.playerCycle = this.checked; bodyChanged(); });
    $('#rpg-vit-ppreg').prop('checked', !!settings.playerPregnancy).on('change', function () { settings.playerPregnancy = this.checked; bodyChanged(); });
    $('#rpg-vit-phide').prop('checked', settings.playerHidePreg !== false).on('change', function () { settings.playerHidePreg = this.checked; bodyChanged(); });
    $('#rpg-vit-pevery').val(settings.cycleDayEvery || 30).on('change', function () { settings.cycleDayEvery = Math.max(4, Math.min(200, parseInt(this.value, 10) || 30)); this.value = settings.cycleDayEvery; saveSettings(); });
    $('#rpg-vit-pday').on('change', function () {
        const c = cycleState(); const ci = playerCycleInfo();
        if (!c || !ci || ci.preg) return;
        c.start = c.day - (Math.max(1, Math.min(ci.len, parseInt(this.value, 10) || 1)) - 1);
        saveState(); bodyChanged();
    });
    $('#rpg-vit-ppill').prop('checked', !!settings.playerPill).on('change', function () { settings.playerPill = this.checked; bodyChanged(); });
    $('#rpg-vit-pend').on('click', () => { endPlayerPregnancy('manual'); bodyChanged(); });
    $('#rpg-vit-preroll').on('click', () => { settings.playerTraits[personaKey()] = rollPlayerTraits(); bodyChanged(); });
    femLock();
    $('#rpg-vit-combat-inject').prop('checked', settings.combatInject !== false).on('change', function () { settings.combatInject = this.checked; saveSettings(); buildInjection(); });
    $('#rpg-vit-combat-depth').val(typeof settings.combatDepth === 'number' ? settings.combatDepth : settings.injectDepth).on('change', function () { settings.combatDepth = Math.max(0, parseInt($(this).val()) || 0); saveSettings(); buildInjection(); });
    depthLock();
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
    if (getContext().chatId) { loadState(); renderButton(); buildInjection(); renderSkillBar(); }

    eventSource.on(event_types.CHAT_CHANGED, (chatIdArg) => {
        // Release the previous chat's state at once: other modules react to this event too, and a
        // bridge call made before the switch completes must not save into the new chat.
        stateReady = false; currentChatId = null; pendingChatId = chatIdArg || null;
        state = freshState();
        closeComboPick(); hideSkTip();
        setTimeout(() => { loadState(pendingChatId || getContext().chatId); renderButton(); _builtSig = null; renderPanel(); buildInjection(); renderSkillBar(); if (document.getElementById('rpg-sk-win')) renderTreeWin(); }, 100);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => onBotMessage(id));
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, (id) => onSwiped(id));
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, (len) => onDeleted(len));
    ['GENERATION_STOPPED', 'GENERATION_ENDED'].forEach(k => { if (event_types[k]) eventSource.on(event_types[k], () => onGenerationDone()); });
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
    // read-only, for the novel's fight bar (Living Scene): the enemies as they are now, and which meters are on
    getEnemies: () => { syncChat(); return state && Array.isArray(state.enemies) ? state.enemies.map(e => ({ id: e.id, name: String(e.name || ''), hp: Number(e.hp) || 0, max: Number(e.max) || 0 })) : []; },
    meters: () => ({ hunger: !!settings.hungerEnabled, mana: !!settings.manaEnabled, fatigue: !!settings.fatigueEnabled }),
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
    // a foe put into the tracker by another extension (the Map's trials); returns its id
    addEnemy: (name, hp, atk) => { syncChat(); if (!state) return null; const e = addEnemy(String(name || '').slice(0, 80), hp, atk); return e ? e.id : null; },
    removeEnemy: (id) => { syncChat(); if (state && id) removeEnemy(id); },
    // the combat scan for as long as `who` holds it (on = true / false), without changing the checkbox
    holdCombatScan: (who, on) => { const k = String(who || 'other'); if (on) combatHolds.add(k); else combatHolds.delete(k); return combatScanOn(); },
    combatScanOn: () => combatScanOn(),
    // the skill tree: are skills on, a point won in a trial, redraw the bar (a trial began or ended)
    skillsOn: () => skillsOn(),
    addSkillPoints: (n) => { syncChat(); const s = state ? skState() : null; if (!s) return 0; s.bonus = Math.min(999, s.bonus + Math.max(1, Math.min(3, Math.round(Number(n) || 1)))); saveState(); renderSkillBar(); _builtSig = null; renderPanel(); if (document.getElementById('rpg-sk-win')) renderTreeWin(); return s.bonus; },
    // the skills you can use right now (learned, awake, not cooling down) — RPG Map offers them among the choices
    skillsNow: () => { try { syncChat(); const s = state ? skState() : null; if (!s || !skActiveNow() || !myTree()) return []; return s.taken.filter(id => !(s.cd[id] > 0)).map(skillById).filter(Boolean).map(sk => ({ id: sk.id, name: sk.name, desc: sk.desc })); } catch (e) { return []; } },
    // use one as a chosen action: the price is taken and the model is told, the text is sent by the caller
    useSkill: (id) => { try { return useSkill(String(id || ''), { quiet: true }) === true; } catch (e) { return false; } },
    skillsRefresh: () => { try { syncChat(); renderSkillBar(); buildInjection(); if (document.getElementById('rpg-sk-win')) renderTreeWin(); } catch (e) { } },
    // the last intimate scene the story scan saw in this chat: { level: 'romantic'|'sex', with, messageId, at } or null
    lastIntimacy: () => { syncChat(); return state && state.lastIntimacy ? Object.assign({}, state.lastIntimacy) : null; },
    refresh: () => { loadState(getContext().chatId); _builtSig = null; renderPanel(); buildInjection(); }
};

/* ============================================================
   SKILL TREE
   Your own tree, drawn from your persona: two or three branches, three tiers each, and at every
   tier two skills of which you may keep only one — the other is sealed for good. Points come with
   levels and as trial rewards. Up to four learned skills sit as small buttons in the message box,
   plus a joint move with whoever is at your side (it lands or not by their Trust in Bonds).
   A skill costs what it says — mana, health, fatigue, hunger — and the code takes it: health spent
   too freely calls the angel like any other wound. The story model gets one line, at its own depth,
   saying what was done and what it cost. By default skills work only while a trial runs.
   ============================================================ */
const PROMPT_KEY_SKILL = 'rpg_vitals_skill';
const SKILL_KINDS = ['damage', 'heal', 'shield', 'summon', 'reveal', 'escape', 'sway', 'trick'];
const SKILL_BAR_MAX = 4;
const SKILL_TREE_DEFAULT = `You design a small skill tree for a character in a role-play story, drawn from who they are.
Character: {NAME}.
{SOURCE}
{WORLD}
{CLASS}
Everything in the tree must exist in this world as the card and the lorebook describe it: no magic, technology, creatures or customs it does not have (no spells in a world without magic, no machines from a later age).
Make {BRANCHES} branches that fit this character (their nature, training, powers or temperament) and the world. Each branch has 3 tiers; each tier offers two skills, and taking one locks the other forever, so every choice costs something.
Skills are actions the character performs in a scene, not passive bonuses: a strike with their weapon, a thrown flask, a spell, calling a beast to their side, slipping into the shadows, setting a trap, a feint, dragging someone out of danger. Each is something you can picture them doing in one moment of a fight, a chase or a tense scene, and it belongs to this world (a revolver or a vial of arsenic in the 19th century, a hack or a stim in cyberpunk, vaulting a window and dropping a pallet when hunted). Mix them: most act on foes or the surroundings, some strengthen or protect the character or an ally for a few turns.
Every skill has a price paid by the one who uses it: mana, health, fatigue or hunger, or a lasting side effect, and the stronger the skill, the higher the price. Some skills must cost health.
The "desc" says what the character does and what happens, in one vivid sentence.
{LANG}
Output strictly JSON: {"branches":[{"name":"","icon":"one emoji","tiers":[[{"name":"","desc":"one sentence, what it does in the story","cost":{"mana":0,"hp":0,"fatigue":0,"hunger":0},"effect":{"kind":"damage|heal|shield|summon|reveal|escape|sway|trick","power":1},"side":{"name":"","turns":0},"cooldown":2},{...}]]}]}`;
const SKILL_CLASS_DEFAULT = `You suggest character classes for the player of a role-play story, made for this story's world and era.
Player: {NAME}.
{SOURCE}
{WORLD}
Suggest {N} classes that could exist in this world, named the way this world would name them (a necromancer in the 19th century may be a gravedigger who deals in arsenic; in cyberpunk a healer may be a back-alley ripperdoc). Use only what this world has, as the card and the lorebook describe it: no titles, crafts or powers it does not know. Make them different from each other: support, harm, cunning, summoning, protection.
{LANG}
Output strictly JSON: {"classes":[{"name":"two or three words","icon":"one emoji","desc":"at most eight words: what they do"}]}`;
const SKILL_USE_DEFAULT = `[{NAME} uses "{SKILL}": {DESC} Price paid: {COST}.{SIDE} Show it in the story now, the effect and the price.]`;
const SKILL_COMBO_DEFAULT = `[{NAME} calls {PARTNER} for a joint move "{SKILL}". {PARTNER} {RESULT}. Show it in the story now.]`;
const SKILL_COMBO_OK = 'joins in and it lands';
const SKILL_COMBO_FAIL = 'refuses or is too late, and the move fails';
const SKILL_KIND_ICON = { damage: '⚔️', heal: '✚', shield: '🛡️', summon: '🐾', reveal: '👁️', escape: '💨', sway: '🗣️', trick: '🪤' };

/* The answer of a local model: in a code fence, with a word before it, sometimes with a trailing comma.
   The first whole object is taken; nothing is evaluated. */
/* What small local models get wrong in a long JSON answer, put right before reading it:
   quotes inside a text ("a "ghost" walks"), line breaks inside a text, // comments,
   a missing comma between two items. Only the punctuation is touched, never the words. */
function skRepairJson(src) {
    const t0 = String(src || '');
    let out = '', inS = false, q = '"', isKey = false, k = 0;
    const stack = [];   // the open { and [ around
    const nextSolid = j => { while (j < t0.length && /\s/.test(t0[j])) j++; return j; };
    for (; k < t0.length; k++) {
        const c = t0[k];
        if (inS) {
            if (c === '\\') { if (t0[k + 1] === "'") out += "'"; else out += c + (t0[k + 1] ?? ''); k++; continue; }
            if (c === '"' && q === "'") { out += '\\"'; continue; }                 // 'say "no"' -> "say \"no\""
            if (isKey && (c === ':' || c === '\n')) { inS = false; out += '"' + (c === ':' ? ':' : '\n'); continue; }   // "fatigue: 5  -> "fatigue": 5
            if (c === q) {
                const j = nextSolid(k + 1), d = t0[j];
                // a real closing quote is followed by , : } ] or the end; a quote then a new line then "..." is a missing comma
                const after = d === ',' || d === ':' ? t0[nextSolid(j + 1)] : '';
                // a text that is the value of a name in an object is followed by the next name ("cost": …) or the
                // end of the object: "names it "the Ledger", "the Debt", and it obeys" stays one text
                const inObjVal = !isKey && stack[stack.length - 1] === '{';
                const keyNext = () => /^\s*(["'][^"'\n]{1,40}["']|["']?[A-Za-z_]\w{0,40})\s*:/.test(t0.slice(j + 1, j + 60)) || /^\s*[}\]]/.test(t0.slice(j + 1, j + 8));
                const lit = /^(true|false|null)(?![\w])/.test(t0.slice(nextSolid(j + 1), nextSolid(j + 1) + 6));
                const ends = j >= t0.length || '}]'.includes(d)
                    || (d === ',' && (inObjVal ? keyNext() : (after === undefined || '"\'{[}]/'.includes(after))))   // "...", "next"  — not  "a "ghost", it walks"
                    || (d === ':' && !inObjVal && (after === undefined || /["'{\[\d\-]/.test(after) || lit))   // a name ends at its colon; a value never does ("Her rule: "Pay first": then…")
                    || (d === '"' && /[\r\n]/.test(t0.slice(k + 1, j)));
                if (ends) { inS = false; out += '"'; }
                else out += q === '"' ? '\\"' : "'";
                continue;
            }
            if (c === '\n') { out += '\\n'; continue; }
            if (c === '\r') continue;
            if (c === '\t') { out += ' '; continue; }
            out += c; continue;
        }
        // a name without quotes ({name: "x", cost: {...}}) gets them
        if (/[A-Za-z_]/.test(c) && stack[stack.length - 1] === '{' && /[{,]$/.test(out.replace(/\s+$/, ''))) {
            const m = /^[A-Za-z_]\w{0,40}/.exec(t0.slice(k, k + 42));
            if (m && t0[nextSolid(k + m[0].length)] === ':') { out += '"' + m[0] + '"'; k += m[0].length - 1; continue; }
        }
        if (c === '/' && t0[k + 1] === '/') { while (k < t0.length && t0[k] !== '\n') k++; out += '\n'; continue; }
        if (c === '/' && t0[k + 1] === '*') { const e = t0.indexOf('*/', k + 2); k = e < 0 ? t0.length : e + 1; continue; }
        if (c === '"' || c === "'") {
            // "a" "b", } {, ] [, 5 "b" with no comma between them
            const prev = out.replace(/\s+$/, '').slice(-1);
            // a name in an object (not a value, not an item of a list): "fatigue: 5 lost its closing quote
            q = c; isKey = stack[stack.length - 1] === '{' && prev !== ':';
            if (prev && /["}\]\w]/.test(prev) && /\s$/.test(out)) out = out.replace(/\s+$/, '') + ',' + out.match(/\s+$/)[0];   // after a text, an object, a list, a number or true/false/null
            inS = true; out += '"'; continue;
        }
        if (c === '}' || c === ']') stack.pop();
        if (c === '{' || c === '[') {
            stack.push(c);
            const prev = out.replace(/\s+$/, '').slice(-1);
            if (prev && '"}]'.includes(prev)) out = out.replace(/\s+$/, '') + ',' + (out.match(/\s+$/) || [''])[0];
        }
        out += c;
    }
    return out;
}
function skLooseJson(text) {
    let src = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const open = src.search(/[{[]/);
    if (open > 0) src = src.slice(open);
    let t0 = skRepairJson(src);
    const i = t0.indexOf('{');
    if (i < 0) return null;
    let depth = 0, inS = false, esc = false, end = -1;
    for (let k = i; k < t0.length; k++) {
        const c = t0[k];
        if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
        if (c === '"') inS = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) return skCutJson(t0.slice(i));
    const body = t0.slice(i, end + 1).replace(/,\s*\{\s*\.\.\.\s*\}/g, '').replace(/,\s*([}\]])/g, '$1');   // "{...}" copied from the example is dropped
    try { return JSON.parse(body); } catch (e) { return null; }
}
/* An answer that stopped in the middle (a local model out of room): everything up to the last finished
   object or list is kept and the open brackets are closed. A half-written skill is simply left out. */
function skCutJson(text) {
    const stack = [];
    let inS = false, esc = false, cut = -1, cutStack = null;
    for (let k = 0; k < text.length; k++) {
        const c = text[k];
        if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
        if (c === '"') inS = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') { stack.pop(); cut = k + 1; cutStack = stack.slice(); }
    }
    if (cut < 0 || !cutStack) return null;
    let body = text.slice(0, cut).replace(/,\s*$/, '');
    for (let k = cutStack.length - 1; k >= 0; k--) body += cutStack[k] === '{' ? '}' : ']';
    body = body.replace(/,\s*\{\s*\.\.\.\s*\}/g, '').replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(body); } catch (e) { return null; }
}
function skillsOn() { return !!(settings.enabled && settings.skillsEnabled); }
function skText(v, max) { return (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : ''; }
function skNum(v, lo, hi, d) { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
function skEmoji(v) { const s = skText(v, 8); return s && !/[<>"'&]/.test(s) ? s : '✦'; }

// whose tree: the persona you play now (her avatar, else her name)
function skPersonaKey() {
    let av = '';
    try { av = String(user_avatar || ''); } catch (e) { av = ''; }
    const me = av ? 'av:' + av : 'nm:' + String(playerName()).toLowerCase();
    // one tree per persona in each world: the same persona may be a necromancer in one story and a netrunner in another
    let world = '';
    try {
        const ctx = getContext();
        if (ctx.groupId) world = 'g:' + ctx.groupId;
        else if (ctx.characterId !== undefined && ctx.characters && ctx.characters[ctx.characterId]) world = 'c:' + (ctx.characters[ctx.characterId].avatar || ctx.characters[ctx.characterId].name);
    } catch (e) { world = ''; }
    return world ? me + '|' + world : me;
}
function normalizeSkill(x, bi, ti, si) {
    if (!x || typeof x !== 'object') return null;
    if (!x.name && x.skill && typeof x.skill === 'object' && !Array.isArray(x.skill)) x = x.skill;   // {"skill": {...}}
    const name = skText(x.name, 60) || skText(x.title, 60) || skText(x.skill, 60) || skText(x.label, 60);
    if (!name) return null;
    const c = x.cost && typeof x.cost === 'object' ? x.cost : {};
    const e = x.effect && typeof x.effect === 'object' ? x.effect : {};
    const kind = SKILL_KINDS.includes(String(e.kind || '').toLowerCase()) ? String(e.kind).toLowerCase() : 'damage';
    const sd = x.side && typeof x.side === 'object' ? x.side : {};
    const sideName = skText(sd.name, 50);
    return {
        id: `b${bi}t${ti}s${si}`,
        name, desc: skText(x.desc, 220),
        cost: { mana: skNum(c.mana, 0, 100, 0), hp: skNum(c.hp, 0, 100, 0), fatigue: skNum(c.fatigue, 0, 100, 0), hunger: skNum(c.hunger, 0, 100, 0) },
        effect: { kind, power: skNum(e.power, 1, 5, 1) },
        side: sideName ? { name: sideName, turns: skNum(sd.turns, 1, 20, 2) } : null,
        cooldown: skNum(x.cooldown, 0, 20, 2)
    };
}
function skFindBranches(v, depth) {
    if (!v || typeof v !== 'object' || depth > 4) return null;
    if (Array.isArray(v)) return v.length && v.every(x => x && typeof x === 'object' && (x.tiers || x.levels || x.skills)) ? v : null;
    if (Array.isArray(v.branches)) return v.branches;
    if (v.branches && typeof v.branches === 'object') return Object.entries(v.branches).map(([k, b]) => Object.assign({ name: k }, b));
    for (const k of Object.keys(v)) { const r = skFindBranches(v[k], depth + 1); if (r) return r; }
    return null;
}
function skTierPair(tier) {
    if (Array.isArray(tier)) return tier;
    if (!tier || typeof tier !== 'object') return [];
    if (Array.isArray(tier.skills)) return tier.skills;
    if (Array.isArray(tier.options)) return tier.options;
    if (Array.isArray(tier.choices)) return tier.choices;
    const vals = Object.values(tier).filter(x => x && typeof x === 'object' && !Array.isArray(x) && (x.name || x.title || (x.skill && typeof x.skill === 'object')));
    return vals;
}
// why the model stopped, in words the player can act on
function skStopWhy(o) {
    if (!o) return '';
    const u = o.usage || {};
    const tok = u.prompt_tokens ? ' ' + t('sk_tok', { i: u.prompt_tokens, o: u.completion_tokens || 0 }) : '';
    if (o.finish === 'length') return ' — ' + t('sk_stop_len') + tok;
    return tok ? ' —' + tok : '';
}
function normalizeTree(raw, nBranches) {
    const arr = skFindBranches(raw, 0);
    if (!arr) return null;
    const branches = arr.slice(0, Math.max(1, nBranches || 3)).map((b, bi) => {
        if (!b || typeof b !== 'object') return null;
        let rawTiers = b.tiers || b.levels;
        if (rawTiers && typeof rawTiers === 'object' && !Array.isArray(rawTiers)) rawTiers = Object.values(rawTiers);   // {"tier1": [...], "tier2": [...]}
        if (!Array.isArray(rawTiers) && Array.isArray(b.skills)) { rawTiers = []; for (let k = 0; k < b.skills.length; k += 2) rawTiers.push(b.skills.slice(k, k + 2)); }
        if (!Array.isArray(rawTiers)) return null;
        const tiers = rawTiers.slice(0, 3).map((tier, ti) => {
            const pair = skTierPair(tier).slice(0, 2).map((s, si) => normalizeSkill(s, bi, ti, si)).filter(Boolean);
            return pair.length === 2 ? pair : null;
        });
        // a model that wrote fewer tiers still gets a tree: the tiers it finished, in order
        const done = []; for (const x of tiers) { if (!x) break; done.push(x); }
        if (!done.length) return null;
        tiers.length = 0; done.forEach(x => tiers.push(x));
        return { name: skText(b.name, 40) || '—', icon: skEmoji(b.icon), tiers };
    }).filter(Boolean);
    if (!branches.length) return null;
    // ids follow the place in the tree, after the gaps are gone
    branches.forEach((b, bi) => b.tiers.forEach((tier, ti) => tier.forEach((s, si) => { s.id = `b${bi}t${ti}s${si}`; })));
    return { branches };
}
function myTree() {
    const all = settings.skillTrees && typeof settings.skillTrees === 'object' ? settings.skillTrees : (settings.skillTrees = {});
    const t0 = all[skPersonaKey()];
    if (!t0) return null;
    if (!t0.__ok) {
        const n = normalizeTree(t0, 6);
        if (!n) { delete all[skPersonaKey()]; return null; }
        Object.defineProperty(n, '__ok', { value: true, enumerable: false });
        n.name = skText(t0.name, 80); n.at = Number(t0.at) || Date.now(); n.cls = skText(t0.cls, 80);
        all[skPersonaKey()] = n;
        return n;
    }
    return t0;
}
function skillById(id) {
    const tr = myTree();
    if (!tr) return null;
    for (const b of tr.branches) for (const tier of b.tiers) for (const s of tier) if (s.id === id) return s;
    return null;
}
function skState() {
    if (!state) return null;
    const s = state.skills && typeof state.skills === 'object' && !Array.isArray(state.skills) ? state.skills : (state.skills = {});
    if (!Array.isArray(s.taken)) s.taken = [];
    if (!Array.isArray(s.bar)) s.bar = [];
    if (!s.cd || typeof s.cd !== 'object' || Array.isArray(s.cd)) s.cd = {};
    if (!Array.isArray(s.pending)) s.pending = [];
    s.taken = s.taken.filter(x => typeof x === 'string' && /^b\dt\ds\d$/.test(x)).slice(0, 18);
    s.bar = s.bar.filter(x => s.taken.includes(x)).slice(0, SKILL_BAR_MAX);
    s.pending = s.pending.filter(x => typeof x === 'string').slice(-4);
    s.bonus = skNum(s.bonus, 0, 999, 0);
    s.comboCd = skNum(s.comboCd, 0, 99, 0);
    Object.keys(s.cd).forEach(k => { if (!/^b\dt\ds\d$/.test(k) || !(Number(s.cd[k]) > 0)) delete s.cd[k]; });
    return s;
}
// one point to start, one per level after the first, and those won in trials
function skPoints() {
    const s = skState();
    if (!s) return 0;
    const lvl = settings.levelEnabled ? Math.max(1, Number(state.level) || 1) : 1;
    return Math.max(0, 1 + (lvl - 1) + s.bonus - s.taken.length);
}
// a skill can be taken when the tier below in its branch is taken and its pair is not
function skStatus(id) {
    const s = skState();
    if (!s) return 'locked';
    if (s.taken.includes(id)) return 'taken';
    const m = /^b(\d)t(\d)s(\d)$/.exec(id);
    if (!m) return 'locked';
    const [, b, t1, k] = m.map(Number);
    if (s.taken.includes(`b${b}t${t1}s${1 - k}`)) return 'sealed';
    if (t1 > 0 && !s.taken.some(x => x === `b${b}t${t1 - 1}s0` || x === `b${b}t${t1 - 1}s1`)) return 'locked';
    return skPoints() > 0 ? 'open' : 'nopoints';
}
function takeSkill(id) {
    syncChat();
    if (skStatus(id) !== 'open') return false;
    const s = skState();
    s.taken.push(id);
    if (s.bar.length < SKILL_BAR_MAX) s.bar.push(id);
    saveState(); renderSkillBar(); renderTreeWin(id);
    return true;
}
function skTrialRunning() {
    try { const m = window.RPG && window.RPG.map; return !!(m && typeof m.trialActive === 'function' && m.trialActive()); } catch (e) { return false; }
}
function skActiveNow() { return skillsOn() && (!settings.skillsOnlyTrials || skTrialRunning()); }

/* ---------- using a skill: the code takes the price and does what it can; the story gets one line ---------- */
function skCostText(c) {
    const out = [];
    if (c.mana) out.push(`${c.mana} mana`);
    if (c.hp) out.push(`${c.hp} health`);
    if (c.fatigue) out.push(`${c.fatigue} fatigue`);
    if (c.hunger) out.push(`${c.hunger} hunger`);
    return out.length ? out.join(', ') : 'nothing';
}
/* What a skill really costs with the meters that are on: mana with mana off is paid in fatigue
   (so a strong skill still costs something), a price on a meter that is off is not taken. */
function skEff(c) {
    const e = { mana: 0, hp: c.hp || 0, fatigue: 0, hunger: 0 };
    if (settings.manaEnabled) e.mana = c.mana || 0;
    else if (settings.fatigueEnabled) e.fatigue += c.mana || 0;
    if (settings.fatigueEnabled) e.fatigue += c.fatigue || 0;
    if (settings.hungerEnabled) e.hunger = c.hunger || 0;
    e.fatigue = Math.min(100, e.fatigue);
    return e;
}
function skCostLabel(c0) {
    const c = skEff(c0);
    const out = [];
    if (c.mana) out.push(`🔮${c.mana}`);
    if (c.hp) out.push(`🩸${c.hp}`);
    if (c.fatigue) out.push(`💤${c.fatigue}`);
    if (c.hunger) out.push(`🍖${c.hunger}`);
    return out.join(' ');
}
function skFill(tpl, vars) { let s = String(tpl); for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k])); return s; }
function skPower(sk) { return sk.effect.power * 6 + Math.floor((settings.levelEnabled ? state.level : 1) / 2); }
function skApplyEffect(sk, mult) {
    const p = Math.round(skPower(sk) * (mult || 1));
    const k = sk.effect.kind;
    if (k === 'damage' && state.enemies.length) {
        const e = state.enemies.reduce((a, b) => (a.hp <= b.hp ? a : b));
        e.hp = Math.max(0, e.hp - p);
        if (e.hp <= 0) { gainKillXp(e); state.enemies = state.enemies.filter(x => x.id !== e.id); return t('sk_fx_down', { name: e.name }); }
        return t('sk_fx_hit', { name: e.name, n: p });
    }
    if (k === 'heal') { state.hp = Math.min(state.maxHp, state.hp + p); return t('sk_fx_heal', { n: p }); }
    if (k === 'shield' || k === 'summon') {
        addBuff({ name: sk.name, effect: sk.desc, kind: 'buff', duration: Math.max(2, sk.effect.power + 1) });
        return t('sk_fx_buff', { name: sk.name });
    }
    return '';
}
function skPay(c0) {
    // a price that cannot be paid stops the skill: mana and fatigue are counted only when they are on
    const c = skEff(c0);
    if (c.mana && settings.manaEnabled && (Number(state.mana) || 0) < c.mana) return t('sk_no_mana');
    if (c.fatigue && settings.fatigueEnabled && (Number(state.fatigue) || 0) + c.fatigue > 100) return t('sk_too_tired');
    if (c.mana && settings.manaEnabled) state.mana = Math.max(0, state.mana - c.mana);
    if (c.fatigue && settings.fatigueEnabled) state.fatigue = Math.min(100, (state.fatigue || 0) + c.fatigue);
    if (c.hunger && settings.hungerEnabled) state.hunger = Math.max(0, (state.hunger || 0) - c.hunger);
    if (c.hp) { state.hp = state.hp - c.hp; clampHp(); }   // blood: the angel is called the usual way when it runs out
    return '';
}
// the skill in your own message, as your character's action: you send it with the rest
function skToBox(text) {
    try {
        const box = document.getElementById('send_textarea');
        if (!box) return;
        const cur = String(box.value || '').replace(/\s+$/, '');
        box.value = cur ? cur + '\n' + text : text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.focus();
        try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { }
    } catch (e) { }
}
function useSkill(id, opts) {
    syncChat();
    if (!state || !skActiveNow()) { toastr.info(t(settings.skillsOnlyTrials ? 'sk_only_trials' : 'sk_off')); return; }
    const s = skState();
    const sk = skillById(id);
    if (!sk || !s.taken.includes(id)) return;
    if (s.cd[id] > 0) { toastr.info(t('sk_cooldown', { n: s.cd[id] })); return false; }
    const err = skPay(sk.cost);
    if (err) { toastr.warning(err); return false; }
    if (sk.side) addBuff({ name: sk.side.name, effect: '', kind: 'debuff', duration: sk.side.turns });
    const onOther = !!(opts && opts.target);
    const fx = onOther ? t('sk_fx_on', { name: opts.target }) : skApplyEffect(sk, 1);
    // the Map's party keeps the others' health: a heal on them reaches it
    if (onOther) { try { window.dispatchEvent(new CustomEvent('rpg:vitals-skill', { detail: { target: opts.target, kind: sk.effect.kind, amount: skPower(sk) } })); } catch (e) { } }
    if (sk.cooldown) s.cd[id] = sk.cooldown;
    s.queued = (Array.isArray(s.queued) ? s.queued : []).concat(id).slice(-4);
    const line = skFill(String(settings.skillUseLine || '').trim() ? settings.skillUseLine : SKILL_USE_DEFAULT, {
        NAME: playerName(), SKILL: sk.name, DESC: sk.desc || sk.name, COST: skCostText(skEff(sk.cost)),
        SIDE: sk.side ? ` Side effect: ${sk.side.name} for ${sk.side.turns} turns.` : ''
    });
    s.pending.push(line);
    saveState(); renderPanel(); buildInjection(); renderSkillBar();
    try { window.dispatchEvent(new CustomEvent('rpg:vitals-enemies', { detail: { skill: true } })); } catch (e) { }
    if (!(opts && opts.quiet)) skToBox(onOther
        ? t('sk_box_on', { name: playerName(), skill: sk.name, target: opts.target, desc: sk.desc || '' }).replace(/:\s*\*$/, '.*')
        : t('sk_box_use', { name: playerName(), skill: sk.name, desc: sk.desc || '' }).replace(/:\s*\*$/, '.*'));
    toastr.success(`${sk.name}${fx ? ' — ' + fx : ''}${opts && opts.quiet ? '' : '. ' + t('sk_next_reply')}`, t('sk_used'));
    return true;
}

/* the joint move: whoever is with you; Trust in Bonds is the chance */
function skPartners() {
    const out = [];
    try {
        const m = window.RPG && window.RPG.map;
        if (m && typeof m.companions === 'function') (m.companions() || []).forEach(n => { if (n && !out.includes(n)) out.push(String(n)); });
    } catch (e) { }
    if (!out.length) {
        const ctx = getContext();
        if (ctx.groupId && Array.isArray(ctx.groups)) {
            const g = ctx.groups.find(x => x && x.id === ctx.groupId);
            (g && g.members || []).forEach(av => { const ch = (ctx.characters || []).find(c => c.avatar === av); if (ch && !out.includes(ch.name)) out.push(ch.name); });
        } else if (ctx.name2) out.push(ctx.name2);
    }
    return out.slice(0, 6);
}
function skTrust(name) {
    try {
        const b = window.RPG && window.RPG.bonds;
        if (b && typeof b.trust === 'function') { const v = b.trust(name); if (Number.isFinite(v)) return Math.max(0, Math.min(100, v)); }
    } catch (e) { }
    return null;
}
function useCombo(partner, id) {
    syncChat();
    if (!state || !skActiveNow()) { toastr.info(t(settings.skillsOnlyTrials ? 'sk_only_trials' : 'sk_off')); return; }
    const s = skState();
    const sk = skillById(id);
    if (!sk || !s.taken.includes(id) || !partner) return;
    if (s.comboCd > 0) { toastr.info(t('sk_cooldown', { n: s.comboCd })); return; }
    const err = skPay(sk.cost);
    if (err) { toastr.warning(err); return; }
    const trust = skTrust(partner);
    const chance = trust == null ? 50 : Math.max(10, Math.min(95, trust));
    const roll = Math.floor(Math.random() * 100) + 1;
    const hit = roll <= chance;
    const fx = hit ? skApplyEffect(sk, 2) : '';
    s.comboCd = 5;
    s.comboQueued = true;
    const line = skFill(String(settings.skillComboLine || '').trim() ? settings.skillComboLine : SKILL_COMBO_DEFAULT, {
        NAME: playerName(), PARTNER: partner, SKILL: sk.name, RESULT: hit ? SKILL_COMBO_OK : SKILL_COMBO_FAIL
    });
    s.pending.push(line);
    saveState(); renderPanel(); buildInjection(); renderSkillBar();
    try { window.dispatchEvent(new CustomEvent('rpg:vitals-enemies', { detail: { skill: true } })); } catch (e) { }
    skToBox(t('sk_box_combo', { name: playerName(), partner, skill: sk.name }));
    const msg = t(hit ? 'sk_combo_ok' : 'sk_combo_fail', { name: partner, roll, chance });
    (hit ? toastr.success : toastr.warning)(`${msg}${fx ? ' — ' + fx : ''}`, sk.name);
}

// one reply later: cooldowns step down, the told lines are spent
function skillTick() {
    const s = state && state.skills ? skState() : null;
    if (!s) return;
    Object.keys(s.cd).forEach(k => { s.cd[k] = s.cd[k] - 1; if (s.cd[k] <= 0) delete s.cd[k]; });
    if (s.comboCd > 0) s.comboCd--;
    s.pending = [];
    s.queued = [];
    s.comboQueued = false;
}
function skillInjection() {
    let text = '';
    const s = skillsOn() && state && state.skills ? skState() : null;
    if (s && s.pending.length) text = '\n' + s.pending.join('\n') + '\n';
    try { setExtensionPrompt(PROMPT_KEY_SKILL, text, 1, skNum(settings.skillDepth, 0, 50, 2), false, extension_prompt_roles.SYSTEM); } catch (e) { }
}

/* ---------- the class: suggested by the model for this world, or written by hand ---------- */
let treeChoosing = false;   // the class screen is open over an existing tree ("grow anew")
let classBusy = false;
let skClassFresh = false;   // the tiles come in one by one only right after they arrive
function skClassBox() {
    const all = settings.skillClasses && typeof settings.skillClasses === 'object' && !Array.isArray(settings.skillClasses) ? settings.skillClasses : (settings.skillClasses = {});
    const k = skPersonaKey();
    const b = all[k] && typeof all[k] === 'object' ? all[k] : (all[k] = {});
    b.list = (Array.isArray(b.list) ? b.list : []).map(x => x && typeof x === 'object' ? { name: skText(x.name, 60), desc: skText(x.desc, 200), icon: x.icon ? skEmoji(x.icon) : '' } : null).filter(x => x && x.name).slice(0, 8);
    b.chosen = b.chosen && typeof b.chosen === 'object' && skText(b.chosen.name, 60) ? { name: skText(b.chosen.name, 60), desc: skText(b.chosen.desc, 200) } : null;
    return b;
}
function skChosen() { return skClassBox().chosen; }
// the world, as the character card tells it (several cards in a group)
async function skWorld() {
    const parts = [];
    if (settings.skillScanCard) { const c = skWorldCard(); if (c) parts.push(c); }
    if (settings.skillScanLore) { try { const l = await skWorldLore(); if (l) parts.push(l); } catch (e) { console.warn('[RPG Vitals] lorebook', e); } }
    return parts.join('\n\n');
}
/* The lorebooks of this chat: the character's own, the chat's, and the ones switched on for every chat.
   Only enabled entries, each as "title: text", within a budget. */
async function skWorldLore() {
    const ctx = getContext();
    if (typeof ctx.loadWorldInfo !== 'function') return '';
    const names = new Set();
    const addCh = ch => { const w = ch && ch.data && ch.data.extensions && ch.data.extensions.world; if (w) names.add(String(w)); };
    if (ctx.groupId && Array.isArray(ctx.groups)) {
        const g = ctx.groups.find(x => x && x.id === ctx.groupId);
        (g && g.members || []).forEach(av => addCh((ctx.characters || []).find(c => c.avatar === av)));
    } else if (ctx.characterId !== undefined && ctx.characters) addCh(ctx.characters[ctx.characterId]);
    try { const cw = ctx.chatMetadata && ctx.chatMetadata.world_info; if (cw) names.add(String(cw)); } catch (e) { }
    try { (Array.isArray(selected_world_info) ? selected_world_info : []).forEach(n => n && names.add(String(n))); } catch (e) { }
    const out = [];
    let left = 12000;
    for (const n of names) {
        if (left <= 0) break;
        let data = null;
        try { data = await ctx.loadWorldInfo(n); } catch (e) { data = null; }
        const entries = data && data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : [];
        for (const e of entries) {
            if (!e || e.disable || !String(e.content || '').trim()) continue;
            const title = String(e.comment || (Array.isArray(e.key) ? e.key[0] : '') || '').trim();
            const line = `${title ? title + ': ' : ''}${String(e.content).replace(/\s+/g, ' ').trim()}`.slice(0, 1500);
            out.push(line); left -= line.length;
            if (left <= 0) break;
        }
    }
    return out.length ? `The world (from the lorebook):\n${out.join('\n').slice(0, 12000)}` : '';
}
function skWorldCard() {
    try {
        const ctx = getContext();
        const pick = ch => ch ? [ch.description, ch.scenario].filter(Boolean).join('\n') : '';
        let text = '';
        if (ctx.groupId && Array.isArray(ctx.groups)) {
            const g = ctx.groups.find(x => x && x.id === ctx.groupId);
            text = (g && g.members || []).map(av => (ctx.characters || []).find(c => c.avatar === av)).filter(Boolean).map(ch => `${ch.name}: ${pick(ch)}`).join('\n\n');
        } else if (ctx.characterId !== undefined && ctx.characters && ctx.characters[ctx.characterId]) text = pick(ctx.characters[ctx.characterId]);
        text = String(text || '').trim();
        return text ? `The world (from the character card):\n${text.slice(0, 12000)}` : '';
    } catch (e) { return ''; }
}
async function suggestClasses() {
    if (classBusy) return;
    if (!apiKey()) { toastr.error(t('sk_no_key')); return; }
    const key = skPersonaKey();
    classBusy = true; renderTreeWin();
    try {
        const sys = skFill(String(settings.skillClassPrompt || '').trim() ? settings.skillClassPrompt : SKILL_CLASS_DEFAULT, {
            NAME: playerName(), SOURCE: skSource(), WORLD: await skWorld(), N: 6, LANG: `Write the names and descriptions in ${genLang()}.`
        }).replace(/\n{3,}/g, '\n\n');
        let list = null;
        for (let i = 0; i < 2 && !list; i++) {
            const raw = await callAI(sys, i ? 'Suggest the classes. Reply with the JSON object only.' : 'Suggest the classes.', { maxTokens: 1500, lenient: true, once: true });
            const arr = Array.isArray(raw) ? raw : (raw && (raw.classes || raw.class_list));
            if (Array.isArray(arr)) list = arr.map(x => typeof x === 'string' ? { name: skText(x, 60), desc: '', icon: '' } : { name: skText(x && x.name, 60), desc: skText(x && (x.desc || x.description), 200), icon: x && x.icon ? skEmoji(x.icon) : '' }).filter(x => x.name).slice(0, 8);
            if (list && !list.length) list = null;
        }
        if (skPersonaKey() !== key) return;
        if (!list) { toastr.error(t('sk_class_fail')); return; }
        const b = skClassBox(); b.list = list; skClassFresh = true; saveSettings();
    } catch (e) {
        console.warn('[RPG Vitals] classes', e);
        toastr.error(t('sk_class_fail'));
    } finally { classBusy = false; renderTreeWin(); }
}
function skClassHtml() {
    const b = skClassBox();
    const ch = b.chosen;
    const fresh = skClassFresh; skClassFresh = false;
    return `<div class="rpg-sk-class${fresh ? ' fresh' : ''}">
        <div class="rpg-sk-class-h"><span>${escapeHtml(t('sk_class_h'))}</span></div>
        ${!b.list.length && classBusy ? `<div class="rpg-sk-class-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('sk_class_busy'))}</div>` : ''}
        ${b.list.length ? `<div class="rpg-sk-class-list">${b.list.map((c, i) => `<button type="button" class="rpg-sk-cls${ch && ch.name === c.name ? ' on' : ''}" data-cls="${i}" aria-pressed="${ch && ch.name === c.name ? 'true' : 'false'}" style="--d:${i * 45}ms"><span class="rpg-sk-cls-ic" aria-hidden="true">${escapeHtml(c.icon || '✦')}</span><span class="rpg-sk-cls-t"><b>${escapeHtml(c.name)}</b>${c.desc ? `<small>${escapeHtml(c.desc)}</small>` : ''}</span></button>`).join('')}</div>` : ''}
        <div class="rpg-sk-class-row">
            <input type="text" class="rpg-sk-own-in" maxlength="80" value="${escapeHtml(ch && !b.list.some(c => c.name === ch.name) ? ch.name : '')}" placeholder="${escapeHtml(t('sk_class_own_ph'))}" aria-label="${escapeHtml(t('sk_class_own'))}">
            <button type="button" class="rpg-sk-roll" data-suggest="1" ${classBusy ? 'disabled' : ''} title="${escapeHtml(b.list.length ? t('sk_class_more') : t('sk_class_suggest'))}">${classBusy ? `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('sk_class_busy'))}` : `✨ ${escapeHtml(b.list.length ? t('sk_class_more') : t('sk_class_suggest'))}`}</button>
        </div>

    </div>`;
}

/* ---------- making the tree ---------- */
let treeBusy = false;
function skSource() {
    let desc = '';
    try { desc = String((power_user && power_user.persona_description) || '').trim(); } catch (e) { desc = ''; }
    if (desc) return `Who they are:\n${desc.slice(0, 20000)}`;
    try {
        const d = window.RPG && window.RPG.diary;
        const sum = d && d.available && d.isEnabled && d.isEnabled() && d.getSummary ? String(d.getSummary() || '').trim() : '';
        if (sum) return `What the story knows of them:\n${sum.slice(0, 20000)}`;
    } catch (e) { }
    const chat = getContext().chat || [];
    const tail = chat.slice(-6).filter(m => m && !m.is_system).map(m => `${m.name}: ${String(m.mes || '').replace(/\s+/g, ' ').slice(0, 800)}`).join('\n');
    return `Little is written about them; draw on the latest messages:\n${tail || '—'}`;
}
async function makeTree() {
    if (treeBusy) return;
    if (!apiKey()) { toastr.error(t('sk_no_key')); return; }
    const key = skPersonaKey();
    treeBusy = true;
    const btn = document.querySelector('#rpg-sk-win .rpg-sk-main[data-make]');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('sk_making'))}`; }
    let why = '';
    try {
        const n = skNum(settings.skillBranches, 2, 6, 2);
        const sys = skFill(String(settings.skillPrompt || '').trim() ? settings.skillPrompt : SKILL_TREE_DEFAULT, {
            NAME: playerName(), SOURCE: skSource(), BRANCHES: n, LANG: `Write the names and descriptions in ${genLang()}.`, WORLD: await skWorld(),
            CLASS: settings.skillClassesOn && skChosen() ? `Class chosen by the player: ${skChosen().name}${skChosen().desc ? ' (' + skChosen().desc + ')' : ''}. Build every branch around this class.` : ''
        }).replace(/\n{3,}/g, '\n\n');
        let tree = null, part = null, partO = null;
        const full = x => x.branches.length >= n && x.branches.every(b => b.tiers.length >= 3);
        const count = x => x ? x.branches.reduce((a, b) => a + b.tiers.length * 2, 0) : 0;
        for (let i = 0; i < 2 && !tree; i++) {
            const o = { maxTokens: 2000 * n, lenient: true, once: true };
            let raw = null;
            try { raw = await callAI(sys, i ? 'Write the skill tree. Reply with the JSON object only.' : 'Write the skill tree.', o); }
            catch (e) {
                why = String(e && e.message || e).slice(0, 120);
                // a local server may refuse the requested length: once more without it
                if (/HTTP 4\d\d/.test(why) && i === 0) { try { const o2 = { lenient: true, once: true }; raw = await callAI(sys, 'Write the skill tree.', o2); o.raw = o2.raw; why = ''; } catch (e2) { why = String(e2 && e2.message || e2).slice(0, 120); } }
                if (!raw) break;
            }
            tree = normalizeTree(raw, n);
            if (!tree) { why = (o.raw ? t('sk_fail_shape') : t('sk_fail_empty')) + skStopWhy(o); console.warn('[RPG Vitals] the tree answer could not be read:', { finish: o.finish, usage: o.usage, answer: String(o.raw || '').slice(0, 20000) }); }
            else if (!full(tree)) {
                // the model stopped before the tree was whole: asked once more, the fuller one is kept
                console.warn('[RPG Vitals] the tree came back unfinished:', { skills: count(tree), of: n * 6, finish: o.finish, usage: o.usage, answer: String(o.raw || '').slice(0, 12000) });
                if (count(tree) > count(part)) { part = tree; partO = o; }
                tree = null;
            }
        }
        let partial = false;
        if (!tree && part) { tree = part; partial = true; toastr.warning(t('sk_part', { n: count(part), all: n * 6, why: skStopWhy(partO) }), '', { timeOut: 12000 }); }
        if (!tree) { toastr.error(`${t('sk_make_fail')}${why ? ' — ' + why : ''}`); return; }
        if (skPersonaKey() !== key) return;   // the persona changed while the model thought
        tree.name = playerName(); tree.at = Date.now(); tree.cls = settings.skillClassesOn && skChosen() ? skChosen().name : '';
        Object.defineProperty(tree, '__ok', { value: true, enumerable: false });
        settings.skillTrees[key] = tree;
        saveSettings();
        // a new tree: the old choices of this chat no longer point anywhere
        syncChat();
        const s = skState(); if (s) { s.taken = []; s.bar = []; s.cd = {}; saveState(); }
        treeChoosing = false;
        if (!partial) toastr.success(t('sk_made'));
    } catch (e) {
        console.warn('[RPG Vitals] tree', e);
        toastr.error(`${t('sk_make_fail')} — ${String(e && e.message || e).slice(0, 120)}`);
    } finally {
        treeBusy = false;
        renderTreeWin(); renderSkillBar();
    }
}

/* The tree is full and the levels go on: three points to spare grow it one more branch (at most six).
   The prompt is the player's tree prompt for one branch, with the branches it already has named. */
const SKILL_BRANCH_MORE = 'The tree already has these branches: {HAVE}. Make one new branch unlike them, for the same character and world.';
const SKILL_GROW_COST = 3, SKILL_BRANCHES_MAX = 6;
function skTreeFull(tree, s) { return !!(tree && s && tree.branches.every((b, bi) => b.tiers.every((tier, ti) => s.taken.some(id => id.startsWith(`b${bi}t${ti}s`))))); }
function canGrowBranch() {
    const tree = myTree(), s = state ? skState() : null;
    return !!(tree && s && tree.branches.length < SKILL_BRANCHES_MAX && skTreeFull(tree, s) && skPoints() >= SKILL_GROW_COST);
}
async function growBranch() {
    if (treeBusy || !canGrowBranch()) return;
    if (!apiKey()) { toastr.error(t('sk_no_key')); return; }
    const key = skPersonaKey(), tree = myTree();
    treeBusy = true;
    const btn = document.querySelector('#rpg-sk-win [data-grow]');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('sk_growing'))}`; }
    let why = '';
    try {
        const sys = (skFill(String(settings.skillPrompt || '').trim() ? settings.skillPrompt : SKILL_TREE_DEFAULT, {
            NAME: playerName(), SOURCE: skSource(), BRANCHES: 1, LANG: `Write the names and descriptions in ${genLang()}.`, WORLD: await skWorld(),
            CLASS: settings.skillClassesOn && skChosen() ? `Class chosen by the player: ${skChosen().name}${skChosen().desc ? ' (' + skChosen().desc + ')' : ''}. Build every branch around this class.` : ''
        }) + '\n' + SKILL_BRANCH_MORE.replace('{HAVE}', tree.branches.map(b => b.name).join(', '))).replace(/\n{3,}/g, '\n\n');
        let branch = null;
        for (let i = 0; i < 2 && !branch; i++) {
            const o = { maxTokens: 2000, lenient: true, once: true };
            let raw = null;
            try { raw = await callAI(sys, i ? 'Write the new branch. Reply with the JSON object only.' : 'Write the new branch.', o); }
            catch (e) {
                why = String(e && e.message || e).slice(0, 120);
                if (/HTTP 4\d\d/.test(why) && i === 0) { try { const o2 = { lenient: true, once: true }; raw = await callAI(sys, 'Write the new branch.', o2); o.raw = o2.raw; why = ''; } catch (e2) { why = String(e2 && e2.message || e2).slice(0, 120); } }
                if (!raw) break;
            }
            const got = normalizeTree(raw, 1);
            const b = got && got.branches[0];
            if (b && b.tiers.length >= 3) branch = b;
            else { why = (o.raw ? t('sk_fail_shape') : t('sk_fail_empty')) + skStopWhy(o); console.warn('[RPG Vitals] the new branch could not be read:', { finish: o.finish, usage: o.usage, answer: String(o.raw || '').slice(0, 6000) }); }
        }
        if (!branch) { toastr.error(`${t('sk_grow_fail')}${why ? ' — ' + why : ''}`); return; }
        if (skPersonaKey() !== key || myTree() !== tree) return;   // the persona or the tree changed while the model thought
        tree.branches.push(branch);
        saveSettings();
        toastr.success(branch.name, t('sk_grown'));
    } catch (e) {
        console.warn('[RPG Vitals] branch', e);
        toastr.error(`${t('sk_grow_fail')} — ${String(e && e.message || e).slice(0, 120)}`);
    } finally {
        treeBusy = false;
        renderTreeWin(); renderSkillBar();
        treeZoom(0);
    }
}

/* ---------- the bar in the message box ---------- */
function renderSkillBar() {
    let bar = document.getElementById('rpg-vit-skillbar');
    const s = state ? skState() : null;
    const tree = myTree();
    const show = !!(skActiveNow() && s && tree && (s.bar.length || s.taken.length));
    if (!show) { if (bar) bar.remove(); hideSkTip(); return; }
    if (!bar) {
        // its own place in the message box, right after the ☰ (not inside it: that block sizes its children)
        const left = document.getElementById('leftSendForm');
        const host = left ? left.parentElement : document.getElementById('send_form');
        if (!host) return;
        bar = document.createElement('div');
        bar.id = 'rpg-vit-skillbar';
        bar.setAttribute('role', 'toolbar');
        if (left) left.after(bar); else host.appendChild(bar);
        bar.addEventListener('click', onSkillBarClick);
        bar.addEventListener('pointerover', e => { const b = e.target.closest('[data-sk]'); if (b) showSkTip(b, b.dataset.sk); });
        bar.addEventListener('pointerout', e => { if (!e.relatedTarget || !bar.contains(e.relatedTarget)) hideSkTip(); });
        bar.addEventListener('focusin', e => { const b = e.target.closest('[data-sk]'); if (b) showSkTip(b, b.dataset.sk); });
        bar.addEventListener('focusout', hideSkTip);
    }
    bar.setAttribute('aria-label', t('sk_bar'));
    const btn = id => {
        const sk = skillById(id);
        if (!sk) return '';
        const cd = s.cd[id] || 0;
        const q = Array.isArray(s.queued) && s.queued.includes(id);
        const price = skCostLabel(sk.cost);
        return `<button type="button" class="rpg-sk-btn named${cd ? ' cd' : ''}${q ? ' queued' : ''}" data-sk="${escapeHtml(id)}" aria-label="${escapeHtml(sk.name + (cd ? ' · ' + t('sk_cooldown', { n: cd }) : ''))}">
            <span class="rpg-sk-ic" aria-hidden="true">${SKILL_KIND_ICON[sk.effect.kind] || '✦'}</span><span class="rpg-sk-nm">${escapeHtml(sk.name)}</span>${cd ? `<small class="rpg-sk-wait">⏳${cd}</small>` : price ? `<small class="rpg-sk-pr">${escapeHtml(price)}</small>` : ''}</button>`;
    };
    const partners = skPartners();
    const html = `<span class="rpg-sk-row">${s.bar.map(btn).join('')}</span>`
        + (partners.length && s.taken.length ? `<button type="button" class="rpg-sk-btn combo${s.comboCd ? ' cd' : ''}${s.comboQueued ? ' queued' : ''}" data-combo="1" aria-label="${escapeHtml(t('sk_combo') + (s.comboCd ? ' · ' + t('sk_cooldown', { n: s.comboCd }) : ''))}" title="${escapeHtml(t('sk_combo'))}"><span class="rpg-sk-ic" aria-hidden="true">⚡</span>${s.comboCd ? `<span class="rpg-sk-cd">${s.comboCd}</span>` : ''}</button>` : '')
        + `<button type="button" class="rpg-sk-btn tree" data-tree="1" title="${escapeHtml(t('sk_tree'))}" aria-label="${escapeHtml(t('sk_tree'))}"><span class="rpg-sk-ic" aria-hidden="true">🌿</span>${skPoints() ? `<span class="rpg-sk-pt">${skPoints()}</span>` : ''}</button>`;
    if (bar.__html !== html) { bar.innerHTML = html; bar.__html = html; }   // nothing changed: nothing redrawn
}
function onSkillBarClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.tree) { openTreeWin(); return; }
    if (b.dataset.combo) { openComboPick(b); return; }
    if (b.dataset.sk) {
        hideSkTip();
        const sk = skillById(b.dataset.sk);
        // healing or a shield, with someone at your side: on whom
        if (sk && (sk.effect.kind === 'heal' || sk.effect.kind === 'shield') && skPartners().length) { openTargetPick(b, sk); return; }
        useSkill(b.dataset.sk);
    }
}
function openTargetPick(anchor, sk) {
    closeComboPick();
    const p = document.createElement('div');
    p.id = 'rpg-sk-combo';
    p.className = 'rpg-sk-tip combo target';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', t('sk_on_whom'));
    const me = playerName();
    const who = [me].concat(skPartners());
    const ctx = getContext();
    const pic = (n, i) => {
        let src = '';
        if (i === 0) { try { const av = String(user_avatar || ''); if (/^[\w .()\-\[\]]+\.(png|webp|jpe?g)$/i.test(av)) src = `/thumbnail?type=persona&file=${encodeURIComponent(av)}`; } catch (e) { } }
        else { const ch = (ctx.characters || []).find(c => c && c.name === n); if (ch && ch.avatar && /^[\w .()\-\[\]]+\.(png|webp|jpe?g)$/i.test(ch.avatar)) src = `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}`; }
        return src ? `<img src="${escapeHtml(src)}" alt="" draggable="false">` : `<i>${escapeHtml(String(n).trim().charAt(0).toUpperCase())}</i>`;
    };
    p.innerHTML = `<div class="rpg-sk-combo-h"><span aria-hidden="true">${SKILL_KIND_ICON[sk.effect.kind]}</span> ${escapeHtml(sk.name)} · ${escapeHtml(t('sk_on_whom'))}</div>
        <div class="rpg-sk-faces">${who.map((n, i) => `<button type="button" class="rpg-sk-face tgt" data-tgt="${i}" aria-label="${escapeHtml(i === 0 ? t('sk_self') : n)}"><span class="rpg-sk-face-ring" aria-hidden="true">${pic(n, i)}</span><span class="rpg-sk-face-nm">${escapeHtml(i === 0 ? t('sk_self') : n)}</span></button>`).join('')}</div>`;
    p.addEventListener('click', e => {
        const b = e.target.closest('[data-tgt]');
        if (!b) return;
        const i = Number(b.dataset.tgt);
        closeComboPick();
        useSkill(sk.id, i === 0 ? null : { target: who[i] });
    });
    document.body.appendChild(p);
    skPlace(p, anchor);
    setTimeout(() => document.addEventListener('pointerdown', comboOutside, true), 0);
}
function closeComboPick() { const p = document.getElementById('rpg-sk-combo'); if (p) p.remove(); document.removeEventListener('pointerdown', comboOutside, true); }
function comboOutside(e) { const p = document.getElementById('rpg-sk-combo'); if (p && !p.contains(e.target) && !e.target.closest('[data-combo]')) closeComboPick(); }
function openComboPick(anchor) {
    if (document.getElementById('rpg-sk-combo')) { closeComboPick(); return; }
    const s = skState();
    if (!s) return;
    const partners = skPartners();
    const skills = s.taken.map(skillById).filter(Boolean);
    let who = partners[0];
    const p = document.createElement('div');
    p.id = 'rpg-sk-combo';
    p.className = 'rpg-sk-tip combo';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', t('sk_combo'));
    const ctx = getContext();
    const face = n => {
        const ch = (ctx.characters || []).find(c => c && c.name === n);
        const av = ch && ch.avatar && /^[\w .()\-\[\]]+\.(png|webp|jpe?g)$/i.test(ch.avatar) ? `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}` : '';
        const tr = skTrust(n);
        const pct = tr == null ? 50 : Math.round(tr);
        return `<button type="button" class="rpg-sk-face${n === who ? ' on' : ''}" data-who="${escapeHtml(n)}" title="${escapeHtml(n + ' · ' + (tr == null ? t('sk_trust_none') : t('sk_trust', { n: pct })))}" style="--p:${pct}">
            <span class="rpg-sk-face-ring" aria-hidden="true">${av ? `<img src="${escapeHtml(av)}" alt="" draggable="false">` : `<i>${escapeHtml(String(n).trim().charAt(0).toUpperCase())}</i>`}</span>
            <span class="rpg-sk-face-pct">${pct}%</span></button>`;
    };
    const draw = () => {
        p.innerHTML = `<div class="rpg-sk-combo-h"><span aria-hidden="true">⚡</span> ${escapeHtml(t('sk_combo'))}${s.comboCd ? ` <em>${escapeHtml(t('sk_cooldown', { n: s.comboCd }))}</em>` : ''}</div>
            <div class="rpg-sk-faces" role="radiogroup" aria-label="${escapeHtml(t('sk_with'))}">${partners.map(face).join('')}</div>
            <div class="rpg-sk-icons">${skills.map(sk => `<button type="button" class="rpg-sk-btn" data-use="${escapeHtml(sk.id)}" title="${escapeHtml(sk.name + (skCostLabel(sk.cost) ? ' · ' + skCostLabel(sk.cost) : ''))}" aria-label="${escapeHtml(sk.name)}"><span class="rpg-sk-ic" aria-hidden="true">${SKILL_KIND_ICON[sk.effect.kind]}</span></button>`).join('')}</div>`;
    };
    draw();
    p.addEventListener('click', e => {
        const w = e.target.closest('[data-who]');
        if (w) { who = w.dataset.who; draw(); return; }
        const u = e.target.closest('[data-use]');
        if (u) { closeComboPick(); useCombo(who, u.dataset.use); }
    });
    document.body.appendChild(p);
    skPlace(p, anchor);
    setTimeout(() => document.addEventListener('pointerdown', comboOutside, true), 0);
}
function skPlace(el, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.top - h - 10;
    if (y < 8) y = r.bottom + 10;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    el.style.left = x + 'px'; el.style.top = y + 'px';
}
function skDetailHtml(sk, st, pinned, s) {
    const acts = [];
    if (st === 'open') acts.push(`<button type="button" class="rpg-sk-main sm" data-take="${escapeHtml(sk.id)}">${escapeHtml(t('sk_take'))}</button>`);
    if (st === 'taken') acts.push(`<button type="button" class="rpg-sk-pinb${pinned ? ' on' : ''}" data-pin="${escapeHtml(sk.id)}" aria-pressed="${pinned ? 'true' : 'false'}" title="${escapeHtml(pinned ? t('sk_unpin') : t('sk_pin'))}" ${!pinned && s.bar.length >= SKILL_BAR_MAX ? 'disabled' : ''}>📌 ${escapeHtml(pinned ? t('sk_on_bar') : t('sk_pin'))}</button>`);
    return `<div class="rpg-sk-detail">${skTipHtml(sk, st)}${acts.length ? `<div class="rpg-sk-acts">${acts.join('')}</div>` : ''}</div>`;
}
// a skill picked in the tree: only the mark and the little card change
function treeSelect(id) {
    const w = document.getElementById('rpg-sk-win');
    if (!w || !w.querySelector('.rpg-sk-stage')) { renderTreeWin(); return; }
    treeSel = id;
    w.querySelectorAll('.rpg-sk-node.sel').forEach(n => n.classList.remove('sel'));
    const old = w.querySelector('.rpg-sk-detail');
    if (!id) { if (old) old.remove(); return; }
    const node = w.querySelector(`.rpg-sk-node[data-node="${CSS.escape(id)}"]`);
    if (node) node.classList.add('sel');
    const sk = skillById(id), s = skState();
    if (!sk || !s) return;
    const html = skDetailHtml(sk, skStatus(id), s.bar.includes(id), s);
    if (old) { old.outerHTML = html; const n = w.querySelector('.rpg-sk-detail'); if (n) n.classList.add('still'); }
    else w.querySelector('.rpg-sk-stage').insertAdjacentHTML('afterend', html);
}
function skTipHtml(sk, status) {
    const st = { taken: t('sk_st_taken'), sealed: t('sk_st_sealed'), locked: t('sk_st_locked'), open: t('sk_st_open'), nopoints: t('sk_st_nopoints') }[status] || '';
    const s = skState();
    return `<div class="rpg-sk-tip-h"><span aria-hidden="true">${SKILL_KIND_ICON[sk.effect.kind]}</span> ${escapeHtml(sk.name)}</div>
        ${sk.desc ? `<div class="rpg-sk-tip-d">${escapeHtml(sk.desc)}</div>` : ''}
        <div class="rpg-sk-tip-g">
            <span>${escapeHtml(t('sk_k_' + sk.effect.kind))} · ${'◆'.repeat(sk.effect.power)}</span>
            ${skCostLabel(sk.cost) ? `<span>${escapeHtml(t('sk_price'))}: ${escapeHtml(skCostLabel(sk.cost))}</span>` : ''}
            ${sk.side ? `<span class="bad">${escapeHtml(t('sk_side', { name: sk.side.name, n: sk.side.turns }))}</span>` : ''}
            ${sk.cooldown ? `<span>${escapeHtml(t('sk_cd_every', { n: sk.cooldown }))}</span>` : ''}
        </div>
        ${status ? `<div class="rpg-sk-tip-m ${status}">${escapeHtml(st)}${s && s.cd[sk.id] ? ' · ' + escapeHtml(t('sk_cooldown', { n: s.cd[sk.id] })) : ''}</div>` : ''}`;
}
function showSkTip(anchor, id) {
    const sk = skillById(id);
    if (!sk) return;
    let tip = document.getElementById('rpg-sk-tip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'rpg-sk-tip'; tip.className = 'rpg-sk-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = skTipHtml(sk, '');
    skPlace(tip, anchor);
    tip.classList.add('show');
}
function hideSkTip() { const tip = document.getElementById('rpg-sk-tip'); if (tip) tip.remove(); }

/* ---------- the tree window: carried by hand, turned by the wheel, dragged around inside ---------- */
let treeView = { z: 1, x: 0, y: 0 };
let treeSel = null;
// your own class, typed by hand
document.addEventListener('change', e => {
    const inp = e.target && e.target.closest ? e.target.closest('#rpg-sk-win .rpg-sk-own-in') : null;
    if (!inp) return;
    const v = skText(inp.value, 80);
    const box = skClassBox();
    box.chosen = v ? { name: v, desc: '' } : (box.chosen && box.list.some(c => c.name === box.chosen.name) ? box.chosen : null);
    saveSettings();
    document.querySelectorAll('#rpg-sk-win .rpg-sk-cls').forEach(b => { const c = box.list[Number(b.dataset.cls)]; const on = !!(c && box.chosen && box.chosen.name === c.name); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
});
document.addEventListener('keydown', e => { if (e.target && e.target.closest && e.target.closest('#rpg-sk-win .rpg-sk-own-in')) { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); } }, true);
function closeTreeWin() {
    treeChoosing = false;
    const w = document.getElementById('rpg-sk-win');
    if (w) { w.classList.remove('show'); setTimeout(() => { const n = document.getElementById('rpg-sk-win'); if (n && !n.classList.contains('show')) n.remove(); }, 250); }
    document.removeEventListener('keydown', treeKey, true);
    treeSel = null;
}
function treeKey(e) { if (e.key === 'Escape' && document.getElementById('rpg-sk-win')) { e.stopPropagation(); if (treeSel) { treeSel = null; renderTreeWin(); } else closeTreeWin(); } }
function openTreeWin() {
    syncChat();
    if (!skillsOn()) { toastr.info(t('sk_off')); return; }
    let w = document.getElementById('rpg-sk-win');
    if (w && w.classList.contains('show')) { closeTreeWin(); return; }
    treeView = { z: innerWidth < 640 ? 0.8 : 1, x: 0, y: 0 };
    treeSel = null;
    renderTreeWin(undefined, true);
    // no tree and no classes yet: the classes for this world are asked for at once, not hidden behind a button
    try { if (!myTree() && settings.skillClassesOn && !skClassBox().list.length && apiKey() && !classBusy) suggestClasses(); } catch (e) { }
    w = document.getElementById('rpg-sk-win');
    treeView.z = treeFitZ(); treeApply();
    requestAnimationFrame(() => w && w.classList.add('show'));
    document.addEventListener('keydown', treeKey, true);
}
const TREE_COL = 210, TREE_ROW = 112, TREE_NODE = 56;
function treeLayout(tree) {
    const nb = tree.branches.length;
    const W = nb * TREE_COL, H = 4 * TREE_ROW + 30;
    const nodes = [];
    tree.branches.forEach((b, bi) => b.tiers.forEach((tier, ti) => tier.forEach((sk, si) => {
        nodes.push({ sk, bi, ti, si, x: bi * TREE_COL + TREE_COL / 2 + (si ? 44 : -44), y: H - 70 - (ti + 1) * TREE_ROW });
    })));
    return { W, H, nodes, root: { x: W / 2, y: H - 46 } };
}
function renderTreeWin(flashId, create) {
    let w = document.getElementById('rpg-sk-win');
    if (!w) {
        if (!create) return;   // a redraw never opens the window by itself
        w = document.createElement('div');
        w.id = 'rpg-sk-win';
        w.className = 'rpg-sk-win';
        w.setAttribute('role', 'dialog');
        w.setAttribute('aria-label', t('sk_tree'));
        document.body.appendChild(w);
        w.addEventListener('click', onTreeClick);
        skWinDrag(w);
    }
    const tree = myTree();
    const s = skState();
    const pts = skPoints();
    w.style.setProperty('--skw', (tree && !treeChoosing ? Math.max(580, tree.branches.length * TREE_COL + 40) : 580) + 'px');
    let body;
    if (!tree || treeChoosing) {
        body = `<div class="rpg-sk-empty">
            <div class="rpg-sk-seed" aria-hidden="true">🌱</div>
            <p>${escapeHtml(!settings.skillClassesOn ? t('sk_empty_plain') : tree ? t('sk_regrow') : t('sk_empty'))}</p>
            ${settings.skillClassesOn ? skClassHtml() : ''}
            <button type="button" class="rpg-sk-main" data-make="1" ${treeBusy ? 'disabled' : ''}>${treeBusy ? `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(t('sk_making'))}` : `🌿 ${escapeHtml(t('sk_make'))}`}</button>

            ${tree ? `<button type="button" class="rpg-sk-back" data-unchoose="1">← ${escapeHtml(t('sk_back_tree'))}</button>` : ''}</div>`;
    } else {
        const L = treeLayout(tree);
        const pos = {}; L.nodes.forEach(n => { pos[n.sk.id] = n; });
        const lines = [];
        L.nodes.forEach(n => {
            const st = skStatus(n.sk.id);
            const from = n.ti === 0 ? L.root : null;
            const link = (a, b, cls) => lines.push(`<path class="${cls}" d="M${a.x},${a.y} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y}"/>`);
            if (from) link(from, n, st === 'taken' ? 'on' : st === 'sealed' ? 'off' : '');
            else {
                [0, 1].forEach(k => {
                    const p = pos[`b${n.bi}t${n.ti - 1}s${k}`];
                    if (p && skStatus(p.sk.id) !== 'sealed') link(p, n, st === 'taken' && skStatus(p.sk.id) === 'taken' ? 'on' : st === 'sealed' ? 'off' : '');
                });
            }
        });
        const nodesHtml = L.nodes.map(n => {
            const st = skStatus(n.sk.id);
            const pinned = s && s.bar.includes(n.sk.id);
            return `<button type="button" class="rpg-sk-node ${st}${treeSel === n.sk.id ? ' sel' : ''}${flashId === n.sk.id ? ' flash' : ''}" data-node="${escapeHtml(n.sk.id)}" style="left:${n.x - TREE_NODE / 2}px;top:${n.y - TREE_NODE / 2}px" aria-label="${escapeHtml(n.sk.name + ' · ' + t('sk_st_' + st))}">
                <span class="rpg-sk-ic" aria-hidden="true">${st === 'sealed' ? '🔒' : SKILL_KIND_ICON[n.sk.effect.kind]}</span>
                ${pinned ? '<span class="rpg-sk-pin" aria-hidden="true">📌</span>' : ''}
                <span class="rpg-sk-name">${escapeHtml(n.sk.name)}</span></button>`;
        }).join('');
        const heads = tree.branches.map((b, bi) => `<div class="rpg-sk-branch" style="left:${bi * TREE_COL}px;width:${TREE_COL}px"><span aria-hidden="true">${escapeHtml(b.icon)}</span> ${escapeHtml(b.name)}</div>`).join('');
        let panel = '';
        if (treeSel) {
            const sk = skillById(treeSel);
            const st = sk ? skStatus(sk.id) : '';
            if (sk) {
                const pinned = s.bar.includes(sk.id);
                panel = skDetailHtml(sk, st, pinned, s);
            }
        }
        body = `<div class="rpg-sk-stage" tabindex="0" aria-label="${escapeHtml(t('sk_stage'))}">
                <div class="rpg-sk-plane" style="width:${L.W}px;height:${L.H}px;transform:translate(${treeView.x}px,${treeView.y}px) scale(${treeView.z})">
                    ${heads}
                    <svg class="rpg-sk-lines" width="${L.W}" height="${L.H}" aria-hidden="true">${lines.join('')}</svg>
                    <div class="rpg-sk-root" style="left:${L.root.x - 30}px;top:${L.root.y - 30}px" aria-hidden="true">✦</div>
                    ${nodesHtml}
                </div>
                <div class="rpg-sk-zoom"><button type="button" data-zoom="1" aria-label="${escapeHtml(t('sk_zoom_in'))}">+</button><button type="button" data-zoom="-1" aria-label="${escapeHtml(t('sk_zoom_out'))}">−</button><button type="button" data-zoom="0" aria-label="${escapeHtml(t('sk_zoom_fit'))}">⤢</button></div>
            </div>${panel}`;
    }
    const lvl = settings.levelEnabled ? Math.max(1, Number(state && state.level) || 1) : 1;
    w.innerHTML = `
        <div class="rpg-sk-head">
            <span class="rpg-sk-title">🌿 ${escapeHtml(t('sk_tree'))} · ${escapeHtml(playerName())}${tree && tree.cls ? ` · ${escapeHtml(tree.cls)}` : ''}</span>
            ${tree ? `<span class="rpg-sk-pts${pts ? ' has' : ''}" title="${escapeHtml(t('sk_pts_t'))}">${escapeHtml(t('sk_pts', { n: pts }))}</span>` : ''}
            <button type="button" class="rpg-sk-x" data-close="1" aria-label="${escapeHtml(t('close'))}">✕</button>
        </div>
        ${body}
        ${tree && !treeChoosing ? craftsStripHtml() : ''}
        ${tree && !treeChoosing ? `<div class="rpg-sk-foot">
            <span>${escapeHtml(settings.levelEnabled ? t('sk_lvl', { n: lvl }) : t('sk_lvl_off'))}${!skActiveNow() ? ' · ' + escapeHtml(t(settings.skillsOnlyTrials ? 'sk_only_trials' : 'sk_off')) : ''}${tree.branches.length < SKILL_BRANCHES_MAX && skTreeFull(tree, s) && pts < SKILL_GROW_COST ? ' · ' + escapeHtml(t('sk_grow_soon', { n: SKILL_GROW_COST - pts })) : ''}</span>
            <span class="rpg-sk-foot-acts">
                ${canGrowBranch() ? `<button type="button" class="rpg-sk-grow" data-grow="1" title="${escapeHtml(t('sk_grow_t'))}" ${treeBusy ? 'disabled' : ''}>＋ ${escapeHtml(t('sk_grow'))}</button>` : ''}
                <button type="button" class="rpg-sk-ghost" data-reset="1" ${s && s.taken.length ? '' : 'disabled'}>${escapeHtml(t('sk_reset'))}</button>
                <button type="button" class="rpg-sk-ghost" data-make="1" ${treeBusy ? 'disabled' : ''}>${escapeHtml(t('sk_remake'))}</button>
            </span></div>` : ''}`;
    const stage = w.querySelector('.rpg-sk-stage');
    if (stage) skStagePan(stage);
}
/* Crafts beside the tree: what RPG Vendors reports (window.RPG.crafts), each with its
   level and lasting bonus, written out — nothing to hover for. Absent when there are none. */
const CRAFT_ICON = {
    blacksmith: '<path d="M14 6l4 4M13 7l4 4-7 7-4-4zM13 7l3-3 4 4-3 3M3 21l7-7"/>',
    tailor: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M8 8l12 12M8 16L20 4"/>',
    apothecary: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
    cook: '<path d="M5 3v7a2 2 0 0 0 2 2v9M7 3v7M9 3v7M16 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4v9"/>',
    merchant: '<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18"/>',
    jeweler: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18"/>',
    trainer: '<circle cx="12" cy="6" r="2.5"/><path d="M12 9v6M8 21l4-6 4 6M6 12h12"/>'
};
function craftsStripHtml() {
    let list = [];
    try { list = window.RPG && window.RPG.crafts && typeof window.RPG.crafts.list === 'function' ? window.RPG.crafts.list() : []; } catch (e) { list = []; }
    if (!Array.isArray(list) || !list.length) return '';
    const chips = list.slice(0, 8).map(c => {
        const lv = Math.max(1, Math.min(5, Number(c.level) || 1)), mx = Math.max(lv, Math.min(5, Number(c.max) || 5));
        const pips = Array.from({ length: mx }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('');
        return `<div class="rpg-sk-craft${c.pct ? ' has' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CRAFT_ICON[c.type] || CRAFT_ICON.merchant}</svg>
            <span class="rpg-sk-craft-in"><span class="rpg-sk-craft-n">${escapeHtml(c.skill)} <span class="rpg-sk-craft-p" aria-label="${lv}/${mx}">${pips}</span></span><span class="rpg-sk-craft-b">${escapeHtml(c.text || '')}</span></span></div>`;
    }).join('');
    return `<div class="rpg-sk-crafts" title="${escapeHtml(t('sk_crafts_t'))}"><span class="rpg-sk-crafts-l">${escapeHtml(t('sk_crafts'))}</span><div class="rpg-sk-crafts-row">${chips}</div></div>`;
}
function treeApply() { const p = document.querySelector('#rpg-sk-win .rpg-sk-plane'); if (p) p.style.transform = `translate(${treeView.x}px,${treeView.y}px) scale(${treeView.z})`; }
function treeFitZ() {
    const base = innerWidth < 640 ? 0.8 : 1, st = document.querySelector('#rpg-sk-win .rpg-sk-stage'), tr = myTree();
    if (!st || !tr || !st.clientWidth) return base;
    return Math.max(0.5, Math.min(base, st.clientWidth / (tr.branches.length * TREE_COL + 20)));   // a wide tree is seen whole
}
function treeZoom(d) { treeView.z = d === 0 ? treeFitZ() : Math.max(0.5, Math.min(1.8, treeView.z + d * 0.15)); if (d === 0) { treeView.x = 0; treeView.y = 0; } treeApply(); }
function skStagePan(stage) {
    stage.addEventListener('wheel', e => { e.preventDefault(); treeZoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    stage.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        const sx = e.clientX, sy = e.clientY, ox = treeView.x, oy = treeView.y;
        const tap = ev => { window.removeEventListener('pointerup', tap); if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5 && treeSel) treeSelect(null); };
        window.addEventListener('pointerup', tap);
        stage.classList.add('panning');
        const move = ev => { treeView.x = ox + ev.clientX - sx; treeView.y = oy + ev.clientY - sy; treeApply(); };
        const up = () => { stage.classList.remove('panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    stage.addEventListener('keydown', e => {
        const k = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] }[e.key];
        if (k) { e.preventDefault(); treeView.x += k[0]; treeView.y += k[1]; treeApply(); }
        else if (e.key === '+' || e.key === '=') treeZoom(1);
        else if (e.key === '-') treeZoom(-1);
    });
    stage.addEventListener('pointerover', e => { const n = e.target.closest('[data-node]'); if (n && !treeSel) showSkTip(n, n.dataset.node); });
    stage.addEventListener('pointerout', e => { if (e.target.closest('[data-node]')) hideSkTip(); });
}
function skWinDrag(w) {
    w.addEventListener('pointerdown', e => {
        const h = e.target.closest('.rpg-sk-head');
        if (!h || e.button !== 0 || e.target.closest('button')) return;
        const r = w.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const move = ev => {
            w.style.left = Math.max(-r.width + 80, Math.min(innerWidth - 80, r.left + ev.clientX - sx)) + 'px';
            w.style.top = Math.max(0, Math.min(innerHeight - 40, r.top + ev.clientY - sy)) + 'px';
            w.style.right = 'auto'; w.style.bottom = 'auto'; w.style.margin = '0';
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
}
function onTreeClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.close) { closeTreeWin(); return; }
    if (b.dataset.zoom !== undefined) { treeZoom(Number(b.dataset.zoom)); return; }
    if (b.dataset.make) {
        // over a grown tree "grow anew" first opens the class choice; growing from there asks once
        if (myTree() && !treeChoosing) { treeChoosing = true; treeSel = null; renderTreeWin(); return; }
        if (myTree() && !confirm(t('sk_remake_q'))) return;
        makeTree(); return;
    }
    if (b.dataset.grow) { growBranch(); return; }
    if (b.dataset.unchoose) { treeChoosing = false; renderTreeWin(); return; }
    if (b.dataset.suggest) { suggestClasses(); return; }
    if (b.dataset.cls !== undefined) {
        const box = skClassBox(); const c = box.list[Number(b.dataset.cls)];
        if (!c) return;
        box.chosen = box.chosen && box.chosen.name === c.name ? null : { name: c.name, desc: c.desc };
        saveSettings();
        document.querySelectorAll('#rpg-sk-win .rpg-sk-cls').forEach(x => { const cc = box.list[Number(x.dataset.cls)]; const on = !!(cc && box.chosen && box.chosen.name === cc.name); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        const own = document.querySelector('#rpg-sk-win .rpg-sk-own-in'); if (own && box.chosen) own.value = '';
        return;
    }
    if (b.dataset.reset) {
        if (!confirm(t('sk_reset_q'))) return;
        syncChat(); const s = skState(); if (s) { s.taken = []; s.bar = []; s.cd = {}; saveState(); }
        treeSel = null; renderTreeWin(); renderSkillBar(); return;
    }
    if (b.dataset.node) { hideSkTip(); treeSelect(treeSel === b.dataset.node ? null : b.dataset.node); return; }
    if (b.dataset.take) { const id = b.dataset.take; if (takeSkill(id)) toastr.success(skillById(id).name, t('sk_learned')); return; }
    if (b.dataset.pin) {
        syncChat(); const s = skState(); const id = b.dataset.pin;
        if (s.bar.includes(id)) s.bar = s.bar.filter(x => x !== id); else if (s.bar.length < SKILL_BAR_MAX) s.bar.push(id);
        saveState(); treeSelect(id); renderSkillBar();
        const node = document.querySelector(`#rpg-sk-win .rpg-sk-node[data-node="${CSS.escape(id)}"]`);
        if (node) { const has = node.querySelector('.rpg-sk-pin'); if (s.bar.includes(id) && !has) node.insertAdjacentHTML('beforeend', '<span class="rpg-sk-pin" aria-hidden="true">📌</span>'); else if (!s.bar.includes(id) && has) has.remove(); }
    }
}
