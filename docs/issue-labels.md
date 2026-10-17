# Issue labels and emoji

How issues in this repository are labelled, and what the emoji in labels,
tables and issue comments mean. The current plan lives in the roadmap issue,
[#21 🗺️ Roadmap: priorities and difficulty](https://github.com/arctic-cheetah/AI-Avatar-PMX-MMD/issues/21).

## Labelling rules

Every open issue gets:

1. **One type label:** `enhancement`, `bug`, `documentation`, and so on.
2. **One priority label:** 🔥 P1, ⭐ P2 or 🌱 P3.
3. **One difficulty label:** 🟢 easy, 🟡 medium or 🔴 hard.
4. **Optional area labels:** 🎙️ speech or 🧍 animation, when they apply.

If an issue mixes easy and hard work, split the easy parts into their own
tickets and link them back with "Part of #N". For example, #11, #12 and #10 are
the quick-win parts of #2.

## Priority

How soon the work should happen. Priority is about impact, not effort.

| Label | Meaning | Use it when |
| --- | --- | --- |
| 🔥 **P1: high** | Do next | It unlocks core use (for example, talking to Yidhari) or gives a big quality win |
| ⭐ **P2: medium** | Soon | It is a noticeable improvement with low risk |
| 🌱 **P3: low** | Later | It is nice to have, a large effort, or research |

## Difficulty

How much work and uncertainty the issue carries.

| Label | Meaning | Rough effort | Typical example |
| --- | --- | --- | --- |
| 🟢 **easy** | Low risk, well understood | Hours to a day | Resizable settings panel (#7) |
| 🟡 **medium** | Touches several parts (bridge, worker, renderer) | A few days | Chat bar (#8) |
| 🔴 **hard** | Research, or an uncertain outcome | A week or more | Hand gestures without arm IK bones (#5) |

Estimates are rough guides for planning, not commitments.

## Area

| Label | Covers |
| --- | --- |
| 🎙️ **speech** | TTS, RVC voice conversion, clip trimming, Rhubarb alignment and lip sync |
| 🧍 **animation** | PMX bones, gestures, eye tracking and idle motion |

Work on the UI, the bridge or the LLM connection has no area label yet; the
issue title says which part it touches.

## Type

These are GitHub's default labels.

| Label | Meaning |
| --- | --- |
| `enhancement` | New feature or request |
| `bug` | Something isn't working |
| `documentation` | Improvements or additions to documentation |
| `question` | Further information is requested |
| `good first issue` | Good for newcomers |
| `help wanted` | Extra attention is needed |
| `accessibility` | Barrier affecting people with disabilities |
| `duplicate` | This issue or pull request already exists |
| `invalid` | This doesn't seem right |
| `wontfix` | This will not be worked on |

## Emoji used in issues and comments

| Emoji | Meaning | Where it appears |
| --- | --- | --- |
| 🔥 ⭐ 🌱 | Priority P1, P2, P3 | Labels, roadmap tables |
| 🟢 🟡 🔴 | Difficulty easy, medium, hard | Labels, roadmap tables, feasibility comments |
| 🎙️ | Speech area | Labels, roadmap "Area" column |
| 🧍 | Animation area | Labels, roadmap "Area" column |
| ✅ | Feasible, or done | Feasibility comments |
| ⚠️ | Feasible with effort or a known risk | Feasibility comments |
| 🔬 | Research needed; outcome not guaranteed | Feasibility comments |
| 🗺️ | Roadmap | Issue #21 title |

A difficulty written as "🟢 → 🔴" means the issue has tiers from easy to hard;
the label shows the overall difficulty and the comment explains each tier.

## Finding issues

```bash
gh issue list --label "🔥 P1: high"                    # everything to do next
gh issue list --label "🟢 easy" --label "⭐ P2: medium" # quick wins
gh issue list --label "🎙️ speech"                      # speech pipeline work
```

On GitHub, click any label on an issue to see every issue with that label.

## Recreating the labels

For a fork or a fresh repository:

```bash
gh label create "🔥 P1: high"   --color B60205 --description "Do next: unlocks core use or a big quality win"
gh label create "⭐ P2: medium" --color FBCA04 --description "Soon: noticeable improvement with low risk"
gh label create "🌱 P3: low"    --color 0E8A16 --description "Later: nice to have, large effort or research"
gh label create "🟢 easy"       --color C2E0C6 --description "Hours to a day; low risk"
gh label create "🟡 medium"     --color FEF2C0 --description "A few days; touches several parts"
gh label create "🔴 hard"       --color F9D0C4 --description "A week or more, or research with an uncertain outcome"
gh label create "🎙️ speech"     --color 5319E7 --description "TTS, RVC, trimming, alignment and lip-sync pipeline"
gh label create "🧍 animation"  --color 1D76DB --description "Bones, gestures, eye tracking and idle motion"
```
