# Design System Strategy: The Tactile Zen Scholar

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Tactile Zen Scholar."** 

We are moving away from the rigid, clinical structures of traditional language apps. Instead, we are leaning into an editorial, high-end stationery aesthetic. Imagine the interface as a collection of smooth river stones and high-grade washi paper laid out on a clean study desk. 

This design system rejects the "template" look. We achieve a premium feel through **intentional asymmetry**, where large-scale typography (Display weights) balances against generous negative space. We prioritize "breathing room" over information density, ensuring that the journey of learning Japanese feels like a mindful ritual rather than a digital chore.

---

## 2. Colors & Tonal Depth
The palette transitions from the authoritative depth of Indigo (`primary: #4456ba`) to the soft, inviting embrace of Japanese cherry blossoms and morning mist (`secondary_container: #ffd9df` and `tertiary_container: #b4fdb4`).

### The "No-Line" Rule
To maintain the "Soft Scholar" aesthetic, **1px solid borders are strictly prohibited for sectioning.** Boundaries must be defined solely through background color shifts.
*   **Action:** Place a `surface-container-low` card on a `surface` background to define its edges. Let the shift in tone do the work that a line used to do.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. 
*   **Level 0 (Foundation):** `surface` (#f9f9fb).
*   **Level 1 (Sectioning):** `surface-container-low` (#f2f4f6).
*   **Level 2 (Active Components):** `surface-container-lowest` (#ffffff) for floating cards that need to pop.

### The "Glass & Gradient" Rule
Flat color is the enemy of premium design. 
*   **Signature Textures:** Use a subtle linear gradient for hero backgrounds or major CTAs, transitioning from `primary` (#4456ba) to `primary_container` (#8596ff) at a 135-degree angle.
*   **Glassmorphism:** For floating navigation or modal overlays, use `surface_container_lowest` at 70% opacity with a `24px` backdrop-blur. This creates a "frosted glass" effect that keeps the user grounded in the context of the previous screen.

---

## 3. Typography: The Editorial Voice
We use **Plus Jakarta Sans** for Latin characters and a modern, **Rounded Japanese Font** (e.g., Zen Maru Gothic or similar) for Kanji and Kana.

*   **Display & Headline:** Use `display-lg` (3.5rem) for Kanji characters. In this system, Kanji is art. Treat it with the scale of a museum exhibit.
*   **Contrast in Weight:** Pair `headline-lg` in a bold weight with `body-md` in a regular weight to create a clear, editorial hierarchy.
*   **Legibility vs. Playfulness:** While the Japanese font is rounded (playful), the Latin `body-lg` (Plus Jakarta Sans) remains crisp. This balance ensures the app feels "friendly" without losing its "scholar" credibility.

---

## 4. Elevation & Depth
We eschew "Material" shadows in favor of **Tonal Layering** and **Ambient Glows.**

### The Layering Principle
Depth is achieved by stacking tiers. A `surface-container-lowest` card sitting on a `surface-container-high` background creates a natural lift. This is "High-End Minimalist" depth.

### Ambient Shadows
If a floating effect is required (e.g., for a "Bubbly" button), use an extra-diffused shadow:
*   **Y-offset:** 8px | **Blur:** 24px
*   **Color:** `on_surface` at **6% opacity**. 
*   **The Goal:** The shadow should feel like a soft glow of light, not a dark smudge.

### The "Ghost Border" Fallback
In rare cases where a border is required for accessibility (e.g., input fields), use a **Ghost Border**: 
*   Token: `outline_variant` at **15% opacity**. This creates a suggestion of a container rather than a hard boundary.

---

## 5. Components

### Bubbly Buttons (The Signature CTA)
*   **Shape:** Use the `full` (9999px) roundedness scale.
*   **Color:** A gradient of `primary` to `primary_dim`.
*   **Interaction:** On press, the button should scale down slightly (95%) and the ambient shadow should tighten, mimicking a physical "squish."

### Learning Cards
*   **Shape:** `lg` (2rem) rounded corners.
*   **Structure:** No dividers. Separate the "Kanji" area from the "Meaning" area using a vertical white space of `2rem` (from our spacing scale) or a subtle shift from `surface-container-low` to `surface-container-lowest`.

### Selection Chips
*   **Shape:** `md` (1.5rem) rounded corners.
*   **State:** Unselected chips use `surface-container-high`. Selected chips transition to `primary_container` with `on_primary_container` text.

### Progress Petals (Custom Component)
Instead of a standard progress bar, use a series of overlapping circular "petals" using the `secondary` and `tertiary` pastel tokens. As the user learns, the petals fill with color and "bloom" through a subtle scale-up animation.

---

## 6. Do's and Don'ts

### Do:
*   **Embrace Asymmetry:** Align your "Daily Goal" headline to the left, but place the character illustration slightly off-center to the right. It feels more human.
*   **Use Large Radius:** Stick to `lg` (2rem) and `xl` (3rem) for almost all containers. The world should feel soft.
*   **Tone-on-Tone:** Use `on_primary_container` text on `primary_container` backgrounds. This low-contrast, high-legibility look is a hallmark of premium UI.

### Don't:
*   **Never use pure black:** Use `on_background` (#2e3336) for text. Pure black is too harsh for a "Friendly Scholar."
*   **No Dividers:** If you feel the urge to draw a line between two list items, increase the vertical padding by `1rem` instead.
*   **Avoid Tight Corners:** Anything less than `sm` (0.5rem) roundedness will break the "bubbly" language of this design system.