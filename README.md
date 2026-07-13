# RPG Vitals (HP & Effects)

A SillyTavern extension that gives the player a living **HP bar**, optional **hunger/satiety**, a list of **effects** (buffs / debuffs), and a lightweight **combat / enemy tracker** — all on a hand-drawn "medical examination" card. Each turn it quietly tells the model your current state so the scene reacts to it.

> Part of the RPG suite. It exposes a small bridge (`window.RPG.vitals`) and reads `window.RPG.equipment`, so other modules plug into it — but it works perfectly on its own.

**Version 1.9.8**

---

## ✨ Features

- ❤️ **HP bar** with an animated ECG, current / max, and (in GM mode) Heal / Damage / Set controls.
- 🍖 **Hunger / satiety** (optional) — depletes over messages; at zero you start starving and lose HP. **Eating always adds satiety** (the field is now framed as *satiety*, so a meal never reads as "more hungry").
- 🩹 **Self‑care from your own words** — when *you* narrate eating, drinking, **bandaging a wound, resting or a healing potion**, the extension catches it and applies the effect. The **AI decides a realistic amount** — an ordinary bandage restores only a little and **never** heals to full; real rest or a strong remedy does more.
- 📜 **Effects that actually matter** — active buffs/debuffs are injected with a directive telling the narrator to let them *shape the scene*: each `+` is a real advantage and each `−` a real hindrance in fitting moments (combat, social, physical).
- ✳️ **Effects** — buffs (green) and debuffs (red) with a name, description and a turn duration that ticks down and wears off. Effects added with no duration can auto‑fade after a random number of messages (default up to 20, configurable); **tagged** effects (e.g. a permanent training perk or a worn‑equipment buff) are sticky and only removed explicitly. The list **scrolls** once you have more than a few, so the card never stretches.
- ⚔️ **Combat & enemies** — track foes with their own HP bars, either by hand (GM) or automatically from the story.
- 🧬 **Level, Mana & Fatigue** (each optional) — a tiny `Lv N` badge (XP from defeated enemies + AI story milestones, max 100), plus mana and fatigue bars the story raises and spends.
- 🧠 **Context injection** — a compact note like `[{{user}}'s HP: 70/100. Active effects: +Well-fed (3); −Bruised ribs (1). Hunger: 40/100.]` keeps the character aware of your condition.
- 🛡️ **Equipment aware** — if the Equipment module is present, your weapon sets your attack and armor soaks part of incoming damage.
- 🌍 **Bilingual (RU / EN)**; state is saved per chat.

## 📦 Install

Copy the `RPG-Vitals` folder into:

```
SillyTavern/data/<user>/extensions/
```

Reload SillyTavern and enable it in **Extensions → RPG Vitals (HP & Effects)**.

## ⚙️ Setup

1. Enable **Vitals** and pick your **Language**.
2. Set a **Default max HP** and the **injection depth**.
3. (Optional) turn on **Hunger** and tune how fast it drains and how much starving hurts.
4. For the AI features (auto HP/effects and auto combat) fill in **API URL / Key / Model** (default `google/gemma-4-31b-it`; a small fast model at low temperature is ideal).
5. **Show manual controls (GM)** reveals Heal/Damage/Set, effect and enemy editors — handy for hand-running things. On desktop the card widens into two columns so it stays compact; on narrow screens it stacks and scrolls.

## 🧠 How it works

**Effects** decay one turn per bot message and wear off with a small notice. An effect added without a set duration gets a random one (up to a configurable max, default 20) so buffs/debuffs don't pile up forever — turn this off in settings to keep some effects permanent. **Injection** adds a short state note near the end of the prompt; when you're starving, an extra emphatic line is added right before the reply.

**Combat — two ways to run it:**
- **Manual (GM):** add an enemy (name / HP / Atk), hit it with your equipped weapon's attack, or let it hit you (armor soaks part of the blow).
- **Auto:** turn on **"Let the AI scan the chat for combat"** — the model reads the last few messages, spawns foes that enter the fight, lowers HP as blows land, and clears the ones that die, flee, or that you escape from. You choose how many recent messages to scan (1–10) and whether/what depth the combat state is injected.

Every enemy card has a small **✕** to dismiss it manually at any time (even without GM mode) — useful if a foe lingers after you've left the scene.

## 🧬 Level, Mana & Fatigue (optional)

Three independent toggles in settings, all driven by the story the same way hunger is:

- **Level** — a compact `Lv N` badge with a thin XP bar sits in the card header (no layout stretch). XP comes from **defeating enemies** (scaled by their HP/attack) and from **AI-detected milestones** (finishing a quest, a big victory). Level rises automatically at each XP threshold, up to **100**.
- **Mana** — a 0–100 bar; the auto-detector lowers it when the scene shows casting/using magic and raises it on rest/potions/meditation.
- **Fatigue** — a 0–100 bar (higher = more tired); rises with exertion and combat, falls with rest and sleep.

Each is injected into the prompt when enabled, so the character knows you're low on mana or worn out. GM mode adds a Set control for mana and fatigue. Other modules can nudge them via the bridge (`getMana/addMana/setMana`, `getFatigue/addFatigue/setFatigue`, `getLevel/addXp`) — e.g. a mana potion from the inventory.

## 🔌 Cross-extension bridge

Other modules can affect you through `window.RPG.vitals`: `getHp()`, `heal(n)`, `damage(n)`, `setHp(n,max)`, `feed(n)`, `addBuff(...)`, `removeBuff(idOrName/tag)`, `listBuffs()`, `getMana()/addMana(n)/setMana(n)`, `getFatigue()/addFatigue(n)/setFatigue(n)`, `getLevel()/addXp(n)`, `refresh()`. Examples in the suite: a vendor quest reward lands as a buff; eating a *food* item from the inventory heals you here. Vitals in turn reads `window.RPG.equipment` for attack/defense.

## 🩺 Troubleshooting

- **HP, effects and level reset when a solo chat is converted to a group.** Fixed in 1.10.0. State was stored only under the chat id in `extension_settings`, and a group conversion produces a new chat id, so nothing was found for it. Vitals are now also backed up inside the chat itself (`rpg_vitals_checkpoint` on the last message), the same way the Engine backs up the backpack, so the copied messages carry the state into the group chat. A chat containing only its greeting is never restored from a checkpoint.
- **State leaking between chats.** Fixed in 1.10.0. The state is owned by a single chat: while SillyTavern swaps chats nothing is saved, and a bridge call made mid-switch can no longer write the previous chat's values under the new chat id.

- **An enemy won't go away.** With auto-combat, removal depends on the model noticing the foe left; the wording now also clears enemies when you clearly escape. If one still lingers, click the **✕** on its card.
- **Nothing auto-updates.** Auto HP/effects and auto-combat each need a working API URL/key/model; without them, use GM controls.
- **Double damage in fights.** When auto-combat is on it owns incoming damage, so the HP auto-detect won't also subtract it.
- **Eating showed −20 / did nothing.** Fixed in 1.9.3 — the field is now *satiety* (eating is always positive), and your own "I ate…" message is read too.
- **I bandaged my wound but HP didn't move.** Fixed in 1.9.6 — self‑care in your own message (bandage/rest/potion) now heals a realistic, AI‑decided amount (never 100% from a plain bandage), and can also restore mana/fatigue.
- **Buffs weren't influencing the story.** Fixed in 1.9.4 — an injected directive now tells the narrator to apply active effects as real advantages/hindrances.
- **Stats changed twice when I swiped.** Fixed in 1.9.8 — a bot turn's consequences (buff ticks, hunger drain, AI HP/effect/combat detection) now apply exactly once per message. Swiping or regenerating shows new prose but no longer re-applies the changes on top of the old ones.
- **The card "jumped"/flickered when a stat updated.** Fixed in 1.9.8 — the panel now repaints values in place instead of rebuilding the whole card, so the ECG/pulse animations no longer restart and bars glide smoothly.
