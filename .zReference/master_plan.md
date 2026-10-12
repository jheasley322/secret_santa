# Master Plan

The spec is in `original_specs.md`. Each phase ends with its tests passing, the RLS audit clean (for database phases), and README + help docs updated.

| # | Phase | Delivers |
|---|---|---|
| 1 | **Database** | Tables, RLS, member token functions, `start_draw` / `reshuffle`, pgTAP tests (including "a member can't see someone else's match" and "a draw is impossible when do-not-pair rules block it") |
| 2 | **Elf pages + texting** | Sign-in, my circles, create/edit circle, add/remove members (with phone), `send-texts` Edge Function (dry-run first), Send invites / Re-send / Copy link, progress checklist |
| 3 | **Member page** | `/m/#token`: circle header, list editor, I'm done, everyone's lists |
| 4 | **Draw & reveal** | Draw / Shuffle again / Undo / Show matches / Send the names (Elf); "You drew ___" (member); delivery + opened tracking; optional do-not-pair UI |
| 5 | **Polish + go live** | Festive look, phone-first layout check, family help page, deploy, Textbelt key + URL whitelist, one real test text to the Elf's phone |
