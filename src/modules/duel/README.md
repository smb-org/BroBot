# Duel module

The duel module stores each challenge in the channel Durable Object points round ledger. The challenger's stake is escrowed atomically with the open round and its challenger/target locks. Accepting adds the second stake and resolves both stakes in one transaction.

An unaccepted targeted duel refunds its challenger. An unaccepted open duel uses the round's saved bot setting to either refund or settle against `__house`; no house account appears in the monthly ranking. Disabling the module and cancelling a cockpit tile use the shared round cancellation path, which refunds participants and releases locks.

Commands are configured per channel. German defaults are `!duell` and `!ja`; English defaults are `!duel` and `!yes`. The settings page uses the shared explicit-save editor and its text library stores localized challenge, result, fight, and error messages.
