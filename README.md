# RPG Vitals (HP & Effects)

A SillyTavern extension that gives the player a living **HP bar**, optional **hunger/satiety**, a list of **effects** (buffs / debuffs), and a lightweight **combat / enemy tracker** — all on a hand-drawn "medical examination" card. Each turn it quietly tells the model your current state so the scene reacts to it.

> Part of the RPG suite. It exposes a small bridge (`window.RPG.vitals`) and reads `window.RPG.equipment`, so other modules plug into it — but it works perfectly on its own.

**Version 1.11.1**
<p>
<img width="1672" height="941" alt="9b7200f2-02c4-490a-a6cf-02b85e4ce8ab" src="https://github.com/user-attachments/assets/dabb96b5-7c00-4708-b9eb-5d30aa8704ad" />
</p>

---
## ✨ Features

<img width="396" height="507" alt="Screenshot_12" src="https://github.com/user-attachments/assets/0de1bb4a-808b-4a08-9604-d26d136e4474" />


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

---
## 🕯️ The Angel of the Last Hour

<img width="575" height="510" alt="Screenshot_15" src="https://github.com/user-attachments/assets/f20f405a-2045-4515-95b5-6347cc9019a4" />


When your health reaches zero, the chat doesn't simply end. An angel arrives — tsundere, of no fixed gender, faintly annoyed at having been called down for this — and asks five questions about the world your character lives in: its era, its customs, what the people of that time and place would take for granted. Two wrong answers are forgiven. Three are not.

Win, and you are sent back with 20 health and a blessing, and the angel refuses to be thanked. Lose, and you get a card with your name on it and the offer of a new chat — the old one is never deleted, it is still there to read or pick up again.

Once per chat. Death should cost something.

Off by default; enable it in the Vitals settings, where you can also set how many recent messages the angel reads before writing its questions. If the model can't be reached, the angel brings its own riddles instead — the trial happens either way.

---
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

---
## ✨ Screenshots
<img width="1896" height="861" alt="Preview-RPG Vitals (HP   Effects)" src="https://github.com/user-attachments/assets/832147b7-f02f-4877-8480-b3c54ca90211" />
