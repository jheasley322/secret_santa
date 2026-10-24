-- ===========================================================================
-- 60 -- Texting tables: texts.body and the lifetime credit cap
-- ===========================================================================
-- Spec: "Texting -> HARD LIMITS" 1 (cap starts at 45, only Joe changes it),
-- "Texting details (Phase 2 contract) -> Where the cap lives" and
-- "-> Dry-run bodies". Scenarios TXB-01..09 in tests/SCENARIOS.md.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(19);

select pg_temp.mk_elf('elf_a');
select pg_temp.mk_elf('elf_b');
select pg_temp.mk_circle('CA', 'elf_a');
select pg_temp.mk_members('CA', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_circle('CB', 'elf_b');
select pg_temp.mk_members('CB', 'Zed', 'Yan', 'Xi');

-- TXB-01 texts.body ------------------------------------------------------------
select has_column('public', 'texts', 'body', 'TXB-01 texts.body exists');
select col_type_is('public', 'texts', 'body', 'text', 'TXB-01 texts.body is text');
select col_is_null('public', 'texts', 'body', 'TXB-01 texts.body is nullable');

-- TXB-02 / 03 private.text_budget ----------------------------------------------
select has_table('private', 'text_budget', 'TXB-02 private.text_budget exists');
select col_type_is('private', 'text_budget', 'cap', 'integer', 'TXB-02 cap is integer');
select col_not_null('private', 'text_budget', 'cap', 'TXB-02 cap is not null');
select col_default_is('private', 'text_budget', 'cap', '45', 'TXB-02 cap defaults to 45');
select is((select count(*) from private.text_budget), 1::bigint, 'TXB-03 text_budget holds exactly one row');
select is((select column_default from information_schema.columns where table_schema = 'private' and table_name = 'text_budget' and column_name = 'cap'), '45', 'TXB-03 the cap column defaults to 45 (Joe raises the live value by SQL; spec HARD LIMITS)');
select is(pg_temp.outcome($$insert into private.text_budget (cap) values (100)$$), 'rejected',
          'TXB-03 a second budget row is rejected');

-- TXB-04 / 05 no client can see or touch the cap -------------------------------
select is(
  array[has_table_privilege('anon', 'private.text_budget', 'select, insert, update, delete'),
        has_table_privilege('authenticated', 'private.text_budget', 'select, insert, update, delete'),
        has_schema_privilege('anon', 'private', 'usage'),
        has_schema_privilege('authenticated', 'private', 'usage')],
  array[false, false, false, false],
  'TXB-04 anon and authenticated have no privilege on text_budget or schema private');

select pg_temp.act_as('elf_a');
select throws_ok($$select cap from private.text_budget$$, '42501', null,
                 'TXB-05 a signed-in Elf reading the cap gets permission denied');
select pg_temp.as_postgres();

-- TXB-06 the Elf reads body on their own texts only ----------------------------
insert into public.texts (member_id, kind, status, dry_run, body)
values (pg_temp.id('Ava'), 'invite', 'sent', true, 'pgtap body for Ava'),
       (pg_temp.id('Zed'), 'invite', 'sent', true, 'pgtap body for Zed');
select pg_temp.act_as('elf_a');
select pg_temp.keep('a_bodies', (select string_agg(body, ',' order by body) from public.texts where body like 'pgtap body%'));
select pg_temp.as_postgres();
select is(pg_temp.val('a_bodies'), 'pgtap body for Ava',
          'TXB-06 the Elf sees the dry-run body on their own circle and not on another Elf''s');

-- TXB-07 body is only for dry-run rows -----------------------------------------
select is(pg_temp.outcome($$insert into public.texts (member_id, kind, status, dry_run, body)
                             values (pg_temp.id('Ben'), 'invite', 'sent', false, 'real body')$$),
          'rejected', 'TXB-07 a real (dry_run = false) row with a body is rejected');

-- TXB-08 the Edge Function reads the cap through a service-role-only function --
select is(has_function_privilege('service_role', 'public.text_budget_cap()', 'execute'), true,
          'TXB-08 service_role can execute text_budget_cap()');
select is(
  array[has_function_privilege('anon', 'public.text_budget_cap()', 'execute'),
        has_function_privilege('authenticated', 'public.text_budget_cap()', 'execute')],
  array[false, false], 'TXB-08 anon and authenticated cannot execute text_budget_cap()');

-- TXB-09 the function returns the stored cap -----------------------------------
update private.text_budget set cap = 46;
select pg_temp.act_as_service();
select pg_temp.keep('cap_seen', public.text_budget_cap()::text);
select pg_temp.as_postgres();
select is(pg_temp.val('cap_seen'), '46', 'TXB-09 text_budget_cap() returns the value Joe set');

-- TXB-10 / TXB-11: text_budget_state() is what send-texts actually reads (S1).
-- text_budget_cap() is unused; TXB-08/09 retire in the PR that drops it.
select is(
  array[has_function_privilege('service_role', 'public.text_budget_state()', 'execute'),
        has_function_privilege('anon', 'public.text_budget_state()', 'execute'),
        has_function_privilege('authenticated', 'public.text_budget_state()', 'execute'),
        has_function_privilege('public', 'public.text_budget_state()', 'execute')],
  array[true, false, false, false], 'TXB-10 text_budget_state() is executable by service_role only');

update private.text_budget set cap = 46, used = 7, last_quota = 30;
select pg_temp.act_as_service();
select pg_temp.keep('state_seen', public.text_budget_state()::text);
select pg_temp.as_postgres();
select is(pg_temp.val('state_seen')::jsonb, '{"cap": 46, "used": 7, "last_quota": 30}'::jsonb,
          'TXB-11 text_budget_state() returns exactly cap, used and last_quota as stored');

select * from finish();
rollback;
