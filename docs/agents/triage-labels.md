# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

This repo keeps the default vocabulary, so the mapping is identity — apply these exact strings; do not rename or alias them.

## Other labels in this repo (not triage)

These labels are owned by other skills and must stay available on the tracker (`gh label list`); do not repurpose them:

| Label                     | Used by       | Meaning                                                    |
| ------------------------- | ------------- | ---------------------------------------------------------- |
| `wayfinder:map`           | `/wayfinder`  | The map issue of a wayfinding effort                       |
| `wayfinder:research`      | `/wayfinder`  | Child ticket of type research (AFK)                        |
| `wayfinder:prototype`     | `/wayfinder`  | Child ticket of type prototype (HITL)                      |
| `wayfinder:grilling`      | `/wayfinder`  | Child ticket of type grilling (HITL)                       |
| `wayfinder:task`          | `/wayfinder`  | Child ticket of type task (HITL/AFK manual work)           |

Full usage rules live in the "Wayfinding operations" section of `docs/agents/issue-tracker.md`.
