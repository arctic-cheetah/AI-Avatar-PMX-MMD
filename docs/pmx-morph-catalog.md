# Yidhari PMX facial morph catalog

This inventory comes from the local `yidhari-mmd/伊德海莉.pmx` file, parsed with the project's Three.js MMD parser. It contains **56 vertex morphs**: 15 in the PMX eye panel, 23 in the mouth panel, and 18 in the brow panel. The names and English labels below are copied from the model metadata; the English labels are sometimes duplicated or surprising, so preview a morph on the model before assigning it a new emotion tag.

The renderer currently previews seven semantic moods through `renderer/expression-catalog.js`. `[neutral]` clears the active mood; it is **not** a PMX morph. Automatic blinking uses `まばたき` separately. These local previews are not yet driven by `controller/bridge.py` or the LLM.

| Current control | PMX morphs                      | Pronunciation (Romaji) | State                          |
| --------------- | ------------------------------- | ---------------------- | ------------------------------ |
| `[happy]`     | `笑い`                        | warai                  | Local preview                  |
| `[surprised]` | `びっくり`                    | bikkuri                | Local preview                  |
| `[thinking]`  | `じと目`                      | jito me                | Local preview                  |
| `[troubled]`  | `困る`                        | komaru                 | Local preview                  |
| `[angry]`     | `怒り` + `怒り目`           | ikari + ikari me       | Local preview                  |
| `[sad]`       | `悲しむ`                    | kanashimu              | Eye-only local preview        |
| `[sad-combined]` | `悲しむ` + `真面目` + `口角下げ` | kanashimu + majime + koukaku sage | Experimental local preview |
| `[neutral]`   | None; fades mood morphs to zero | -                      | Controller action              |
| Idle blink      | `まばたき`                    | mabataki               | Automatic, independent of mood |

## Eye panel — 15 morphs

| PMX morph      | Pronunciation (Romaji) | English label in PMX  | Current use     |
| -------------- | ---------------------- | --------------------- | --------------- |
| `ウィンク`   | uinku                  | `Fac_Eye_L_Wink`    | Unmapped        |
| `ウィンク右` | uinku migi             | `Fac_Eye_R_Wink`    | Unmapped        |
| `びっくり`   | bikkuri                | `Fac_Eye_L_Open`    | `[surprised]` |
| `びっくり左` | bikkuri hidari         | `Fac_Eye_L_Open`    | Unmapped        |
| `びっくり右` | bikkuri migi           | `Fac_Eye_R_Open`    | Unmapped        |
| `怒り目`     | ikari me               | `Fac_Eye_Angry`     | `[angry]`     |
| `怒り目２`   | ikari me 2             | `Fac_Eye_MidDown`   | Unmapped        |
| `じと目`     | jito me                | `Fac_Eye_HalfClose` | `[thinking]`  |
| `下眼上`     | shita gan ue           | `Fac_Eye_LowlidUp`  | Unmapped        |
| `眼角下`     | gankaku shita          | `Fac_Eye_MidUp`     | Unmapped        |
| `悲しむ`     | kanashimu              | `Fac_Eye_Sad`       | `[sad]`, `[sad-combined]` |

## Mouth panel — 23 morphs

| PMX morph    | Pronunciation (Romaji) | English label in PMX | Current use                      |
| ------------ | ---------------------- | -------------------- | -------------------------------- |
| `あ`       | a                      | `Fac_Mth_Uu`       | Unmapped; candidate speech shape |
| `い`       | i                      | `Fac_Mth_Ii`       | Unmapped; candidate speech shape |
| `う`       | u                      | `Fac_Mth_Uu`       | Unmapped; candidate speech shape |
| `え`       | e                      | `Fac_Mth_Uu`       | Unmapped; candidate speech shape |
| `お`       | o                      | `Fac_Mth_Uu`       | Unmapped; candidate speech shape |
| `□`       | shikaku                | `Fac_Mth_AaShout`  | Unmapped                         |
| `ワ`       | wa                     | `Fac_Mth_AaTalk`   | Unmapped                         |
| `え２`     | e 2                    | `Fac_Mth_Ee`       | Unmapped                         |
| `い２`     | i 2                    | `Fac_Mth_Ii`       | Unmapped                         |
| `ワ２`     | wa 2                   | `Fac_Mth_Laugh`    | Unmapped                         |
| `お２`     | o 2                    | `Fac_Mth_UuOo`     | Unmapped                         |
| `にやり`   | niyari                 | `Fac_Mth_L_Up`     | Unmapped                         |
| `にやり２` | niyari 2               | `Fac_Mth_L_Up`     | Unmapped                         |
| `口角上げ` | koukaku age            | `Fac_Mth_L_Up`     | Unmapped                         |
| `口角下げ` | koukaku sage           | `Fac_Mth_L_Down`   | `[sad-combined]`                 |
| `口横広げ` | kuchi yoko hiroge      | `Fac_Mth_L_Out`    | Unmapped                         |
| `口横狭め` | kuchi yoko seme        | `Fac_Mth_L_In`     | Unmapped                         |
| `口上`     | kuchi ue               | `Fac_Mth_Up`       | Unmapped                         |
| `口下`     | kuchi shita            | `Fac_Mth_Down`     | Unmapped                         |
| `口左`     | kuchi hidari           | `Fac_Mth_Left`     | Unmapped                         |
| `口右`     | kuchi migi             | `Fac_Mth_Right`    | Unmapped                         |
| `齿下`     | ha shita               | `Fac_Tooth_Down`   | Unmapped                         |
| `齿上`     | ha ue                  | `Fac_Tooth_Up`     | Unmapped                         |

## Brow panel — 18 morphs

| PMX morph    | Pronunciation (Romaji) | English label in PMX | Current use    |
| ------------ | ---------------------- | -------------------- | -------------- |
| `真面目`   | majime                 | `Fac_Ebr_L_Sad`    | `[sad-combined]` |
| `困る`     | komaru                 | `Fac_Ebr_L_Sad`    | `[troubled]` |
| `怒り`     | ikari                  | `Fac_Ebr_L_Angry`  | `[angry]`    |
| `にこり`   | nikori                 | `Fac_Ebr_L_Relax`  | Unmapped       |
| `上`       | ue                     | `Fac_Ebr_L_Up`     | Unmapped       |
| `下`       | shita                  | `Fac_Ebr_L_Down`   | Unmapped       |
| `前`       | mae                    | `Fac_Ebr_L_Front`  | Unmapped       |
| `怒り左`   | ikari hidari           | `Fac_Ebr_L_Angry`  | Unmapped       |
| `怒り右`   | ikari migi             | `Fac_Ebr_R_Angry`  | Unmapped       |
| `困る右`   | komaru migi            | `Fac_Ebr_L_Sad`    | Unmapped       |
| `にこり左` | nikori hidari          | `Fac_Ebr_L_Relax`  | Unmapped       |
| `にこり右` | nikori migi            | `Fac_Ebr_R_Relax`  | Unmapped       |
| `上左`     | ue hidari              | `Fac_Ebr_L_Up`     | Unmapped       |
| `上右`     | ue migi                | `Fac_Ebr_R_Up`     | Unmapped       |
| `下左`     | shita hidari           | `Fac_Ebr_L_Down`   | Unmapped       |
| `下右`     | shita migi             | `Fac_Ebr_R_Down`   | Unmapped       |
| `前左`     | mae hidari             | `Fac_Ebr_L_Front`  | Unmapped       |
| `前右`     | mae migi               | `Fac_Ebr_R_Front`  | Unmapped       |

## Candidates to preview next

| Idea              | Starting morphs to test                                 | Pronunciation (Romaji)          | Why it is only a candidate                                 |
| ----------------- | ------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| Sad tuning        | Compare `[sad]` with `[sad-combined]`              | kanashimu, majime, koukaku sage | Both are local previews; decide whether the added brow and mouth shapes improve the look. |
| Soft smile        | `にこり`, possibly `口角上げ`                       | nikori, koukaku age             | Brow and mouth shapes need to be judged together.          |
| Wink              | `ウィンク` / `ウィンク右` and their `２` variants | uinku / uinku migi and variants | The variants may look different; test each eye separately. |
| Stronger surprise | `びっくり` with `ワ` or `□`                      | bikkuri with wa or shikaku      | Mouth shape may compete with future speech animation.      |

The PMX panel and names establish what controls exist, **not** whether a combination looks natural or whether it can safely share a morph with blinking or lip sync. Add new expressions to the semantic catalog only after a visual preview and a transition test back to neutral.
