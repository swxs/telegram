# Grilling: Init Admin config shape

Type: grilling
Status: resolved
Part of: [Map: `/init` Command Menu spec](../map.md)

## Question

What is the deployment config for the Init Admin list?

Locked: a dedicated list; Init Admins are a subset of the existing allowlist; an empty list means nobody can `/init`.

Still open: the config key name, schema default, and how operators are told that an empty list fail-closes `/init` while other Slash Commands still work for authorized users.

## Answer

- **Key:** `initAdminUserIds`
- **Schema:** number array, default `[]`. Omitting the key is an empty list: nobody can `/init`; other Slash Commands are unchanged.
- **Gate:** existing authorization first (`allowedUserIds` / `allowAllUsers`), then membership in `initAdminUserIds`. When `allowAllUsers` is true, an Init Admin need not also appear in `allowedUserIds`.
- **Validation:** runtime only. Do not fail or warn at load if an id is missing from `allowedUserIds`.
- **Operator docs:** the spec requires one README config-table row for `initAdminUserIds` stating the empty-list fail-close. No environment-variable contract.

Glossary: Init Admin is an authorized user who is also on the Init Admin list — not “a subset of the allowlist” when allow-all is on. See `CONTEXT.md`.
