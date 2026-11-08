-- ===========================================================================
-- 63 -- claim_reshuffle: re-shuffle after the names are sent
-- ===========================================================================
-- Spec: "Re-shuffle after the names are sent", "Circle status", the texts.kind
-- line, and the kind: 'reshuffle' bullet under "Texting".
-- Scenarios RS-01..29 in tests/SCENARIOS.md.
--
-- Contract under test (same return shape and conventions as claim_texts):
--   public.claim_reshuffle(p_circle_id uuid, p_member_ids uuid[], p_dry_run boolean) returns jsonb
--     {"ok": true,  "texts": [{"member_id","text_id"}], "skipped": [{"member_id","reason"}]}
--     {"ok": false, "error": "..."}
--   SECURITY DEFINER, executable by service_role only.
--
-- Every call goes through pg_temp.rs(), which runs it as service_role and keeps
-- any SQL error as text, so a missing function is one red line per assertion
-- instead of aborting the file. A refusal that RAISES instead of returning
-- ok:false also shows up as a failure.
--
-- Randomness: the probability of a false red is given next to each assertion.

begin;
-- \include tests/fixtures/sql/fixtures.sql

create extension if not exists pgrowlocks with schema extensions;

select plan(88);

-- --------------------------------------------------------------- helpers
create function pg_temp.svc(p_sql text) returns text
language plpgsql as $fx$
declare v text;
begin
  perform pg_temp.act_as_service();
  begin
    execute p_sql into v;
  exception when others then
    v := 'error ' || sqlstate || ': ' || sqlerrm;
  end;
  perform pg_temp.as_postgres();
  return coalesce(v, 'null');
end $fx$;

create function pg_temp.ids(variadic p_labels text[]) returns uuid[]
language sql stable as $fx$
  select array_agg(pg_temp.id(l) order by l) from unnest(p_labels) l;
$fx$;

-- Every member id of a circle: what send-texts passes.
create function pg_temp.all_ids(p_circle text) returns uuid[]
language plpgsql as $fx$
declare v uuid[];
begin
  select coalesce(array_agg(id order by id), '{}') into v from public.members where circle_id = pg_temp.id(p_circle);
  return v;
end $fx$;

-- claim_reshuffle as service_role; the jsonb result is kept under p_key.
create function pg_temp.rs(p_key text, p_circle_id uuid, p_members uuid[], p_dry boolean) returns void
language plpgsql as $fx$
declare r text;
begin
  r := pg_temp.svc(format(
    'select public.claim_reshuffle(p_circle_id => %L::uuid, p_member_ids => %L::uuid[], p_dry_run => %L::boolean)::text',
    p_circle_id, p_members, p_dry));
  insert into pg_temp.t_view (label, v)
  values (p_key, case when r like 'error %' or r = 'null' then jsonb_build_object('sql_error', r) else r::jsonb end)
  on conflict (label) do update set v = excluded.v;
end $fx$;

-- The whole circle, by label.
create function pg_temp.rs_all(p_key text, p_circle text, p_dry boolean) returns void
language plpgsql as $fx$
begin
  perform pg_temp.rs(p_key, pg_temp.id(p_circle), pg_temp.all_ids(p_circle), p_dry);
end $fx$;

-- 'false|<error>' or 'true|', and any SQL error, for one-line assertions.
create function pg_temp.res(p_key text) returns text
language sql stable as $fx$
  select coalesce(pg_temp.view(p_key)->>'sql_error',
                  coalesce(pg_temp.view(p_key)->>'ok', 'null') || '|' || coalesce(pg_temp.view(p_key)->>'error', ''));
$fx$;

create function pg_temp.set_budget(p_cap int, p_used int, p_last_quota int) returns void
language plpgsql as $fx$
begin
  execute 'update private.text_budget set cap = $1, used = $2, last_quota = $3' using p_cap, p_used, p_last_quota;
end $fx$;

create function pg_temp.last_quota() returns text
language plpgsql as $fx$
declare v int;
begin
  execute 'select last_quota from private.text_budget' into v;
  return coalesce(v::text, 'null');
end $fx$;

create function pg_temp.can_exec(p_role text, p_sig text) returns boolean
language plpgsql as $fx$
begin
  if to_regprocedure(p_sig) is null then return null; end if;
  return has_function_privilege(p_role, p_sig, 'execute');
end $fx$;

create function pg_temp.mk_old_text(p_member text, p_kind text, p_status text, p_dry boolean, p_minutes int)
returns void
language plpgsql as $fx$
begin
  insert into public.texts (member_id, kind, status, dry_run, created_at)
  values (pg_temp.id(p_member), p_kind, p_status, p_dry, now() - make_interval(mins => p_minutes));
end $fx$;

-- Everything a refusal must leave alone, on one line.
create function pg_temp.snap(p_circle text) returns text
language plpgsql as $fx$
declare
  c uuid := pg_temp.id(p_circle);
  v_opened bigint;
  v_rows bigint;
begin
  select count(*) into v_opened from public.matches where circle_id = c and opened_at is not null;
  select count(*) into v_rows from public.texts t join public.members m on m.id = t.member_id where m.circle_id = c;
  return concat_ws(' | ', pg_temp.draw_sig(p_circle), pg_temp.circle_status(p_circle),
                   'opened ' || v_opened, 'rows ' || v_rows,
                   'used ' || pg_temp.budget_used(), 'quota ' || pg_temp.last_quota());
end $fx$;

-- Texts rows of one kind and status, by label, sorted.
create function pg_temp.rows_for(p_circle text, p_status text, p_kind text default 'reshuffle') returns text
language plpgsql as $fx$
declare v text;
begin
  select coalesce(string_agg(pg_temp.label(t.member_id), ',' order by pg_temp.label(t.member_id)), '')
    into v
    from public.texts t join public.members m on m.id = t.member_id
   where m.circle_id = pg_temp.id(p_circle) and t.status = p_status and t.kind = p_kind;
  return v;
end $fx$;

create function pg_temp.skipped(p_key text, p_reason text) returns text
language sql stable as $fx$
  select coalesce(string_agg(pg_temp.label((s->>'member_id')::uuid), ',' order by pg_temp.label((s->>'member_id')::uuid)), '')
    from jsonb_array_elements(coalesce(pg_temp.view(p_key)->'skipped', '[]')) s
   where s->>'reason' = p_reason;
$fx$;

create function pg_temp.pairs(p_circle text) returns text[]
language plpgsql as $fx$
declare v text[];
begin
  select coalesce(array_agg(giver_id::text || '>' || receiver_id::text), '{}') into v
    from public.matches where circle_id = pg_temp.id(p_circle);
  return v;
end $fx$;

-- Re-shuffle p_runs times in dry-run mode, recording each outcome in t_draws:
-- verdict is 'ok', the draw rule broken, 'repeated a current match', or the
-- refusal. Texts rows are cleared between runs so the rate limit stays out of
-- it. With p_restore set, each run starts again from that fixed draw (labels:
-- giver, receiver, ...), so the samples are independent.
create function pg_temp.rs_loop(p_tag text, p_circle text, p_runs int, p_restore text[] default null) returns void
language plpgsql as $fx$
declare
  v_before text[];
  v_after  text[];
  v_verdict text;
begin
  for i in 1 .. p_runs loop
    if p_restore is not null then
      delete from public.matches where circle_id = pg_temp.id(p_circle);
      perform pg_temp.mk_matches(p_circle, variadic p_restore);
    end if;
    v_before := pg_temp.pairs(p_circle);
    perform pg_temp.rs_all('loop', p_circle, true);
    v_after := pg_temp.pairs(p_circle);
    if pg_temp.view('loop')->>'ok' is distinct from 'true' then
      v_verdict := 'refused: ' || pg_temp.res('loop');
    else
      v_verdict := pg_temp.draw_verdict(p_circle);
      if v_verdict = 'ok' and v_after && v_before then
        v_verdict := 'repeated a current match';
      end if;
    end if;
    insert into pg_temp.t_draws (tag, run, sig, verdict, mutual)
    values (p_tag, i, pg_temp.draw_sig(p_circle), v_verdict, pg_temp.has_mutual(p_circle));
    delete from public.texts t using public.members m
     where m.id = t.member_id and m.circle_id = pg_temp.id(p_circle);
  end loop;
end $fx$;

create function pg_temp.bad_draws(p_tag text) returns text
language sql stable as $fx$
  select coalesce(string_agg(distinct verdict, '; '), '') from pg_temp.t_draws where tag = p_tag and verdict <> 'ok';
$fx$;

-- Members, then no-pairs, then a draw, then sent: the only order the locks allow.
create function pg_temp.to_sent(p_circle text, variadic p_pairs text[]) returns void
language plpgsql as $fx$
begin
  perform pg_temp.mk_matches(p_circle, variadic p_pairs);
  perform pg_temp.set_status(p_circle, 'drawn');
  perform pg_temp.set_status(p_circle, 'sent');
end $fx$;

-- --------------------------------------------------------------- fixtures
select pg_temp.mk_elf('elf_a');
select pg_temp.mk_elf('elf_b');

select pg_temp.set_budget(45, 0, null);

-- 3 kids, one possible rematch.
select pg_temp.mk_circle('R3', 'elf_a');
select pg_temp.mk_members('R3', 'Ava', 'Ben', 'Cy');
select pg_temp.to_sent('R3', 'Ava', 'Ben', 'Ben', 'Cy', 'Cy', 'Ava');

-- 4 kids in a cycle: exactly two rematches, one being the exact reverse.
select pg_temp.mk_circle('R4', 'elf_a');
select pg_temp.mk_members('R4', 'Dan', 'Eli', 'Fay', 'Gia');
select pg_temp.to_sent('R4', 'Dan', 'Eli', 'Eli', 'Fay', 'Fay', 'Gia', 'Gia', 'Dan');

-- 8 kids with do-not-pairs.
select pg_temp.mk_circle('R8', 'elf_a');
select pg_temp.mk_members('R8', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8');
select pg_temp.mk_no_pair('R8', 'K1', 'K3');
select pg_temp.mk_no_pair('R8', 'K2', 'K5');
select pg_temp.mk_no_pair('R8', 'K4', 'K7');
select pg_temp.to_sent('R8', 'K1', 'K2', 'K2', 'K3', 'K3', 'K4', 'K4', 'K5', 'K5', 'K6', 'K6', 'K7', 'K7', 'K8', 'K8', 'K1');

-- Valid today, but no rematch exists: Ima can only give to Jax, which is banned.
select pg_temp.mk_circle('RX', 'elf_a');
select pg_temp.mk_members('RX', 'Ima', 'Jax', 'Kit', 'Lee');
select pg_temp.mk_no_pair('RX', 'Ima', 'Kit');
select pg_temp.mk_no_pair('RX', 'Ima', 'Lee');
select pg_temp.to_sent('RX', 'Ima', 'Jax', 'Jax', 'Ima', 'Kit', 'Lee', 'Lee', 'Kit');

-- For the status checks.
select pg_temp.mk_circle('ROpen', 'elf_a');
select pg_temp.mk_members('ROpen', 'Mia', 'Ned', 'Oli');
select pg_temp.mk_circle('RDrawn', 'elf_a');
select pg_temp.mk_members('RDrawn', 'Pam', 'Quo', 'Rae');
select pg_temp.mk_matches('RDrawn', 'Pam', 'Quo', 'Quo', 'Rae', 'Rae', 'Pam');
select pg_temp.set_status('RDrawn', 'drawn');

-- Real-claim, cap, reserve, rate-limit circles.
select pg_temp.mk_circle('RReal', 'elf_a');
select pg_temp.mk_members('RReal', 'Sam', 'Tia', 'Uma');
select pg_temp.to_sent('RReal', 'Sam', 'Tia', 'Tia', 'Uma', 'Uma', 'Sam');
select pg_temp.mk_circle('RDry', 'elf_a');
select pg_temp.mk_members('RDry', 'Vic', 'Wes', 'Xan');
select pg_temp.to_sent('RDry', 'Vic', 'Wes', 'Wes', 'Xan', 'Xan', 'Vic');
select pg_temp.mk_circle('RCap', 'elf_a');
select pg_temp.mk_members('RCap', 'Yan', 'Zoe', 'Abe');
select pg_temp.to_sent('RCap', 'Yan', 'Zoe', 'Zoe', 'Abe', 'Abe', 'Yan');
select pg_temp.mk_circle('RRes', 'elf_a');
select pg_temp.mk_members('RRes', 'Bea', 'Cal', 'Deb');
select pg_temp.to_sent('RRes', 'Bea', 'Cal', 'Cal', 'Deb', 'Deb', 'Bea');
select pg_temp.mk_circle('RRate', 'elf_a');
select pg_temp.mk_members('RRate', 'Eve', 'Fin', 'Gus');
select pg_temp.to_sent('RRate', 'Eve', 'Fin', 'Fin', 'Gus', 'Gus', 'Eve');
select pg_temp.mk_circle('ROld', 'elf_a');
select pg_temp.mk_members('ROld', 'Hal', 'Ida', 'Jo');
select pg_temp.to_sent('ROld', 'Hal', 'Ida', 'Ida', 'Jo', 'Jo', 'Hal');

-- Phoneless.
select pg_temp.mk_circle('RP', 'elf_a');
select pg_temp.mk_members('RP', 'Kai', 'Lou', 'Max');
select pg_temp.mk_member('Noa', 'RP', null, true, null);
select pg_temp.to_sent('RP', 'Kai', 'Lou', 'Lou', 'Max', 'Max', 'Noa', 'Noa', 'Kai');
select pg_temp.mk_circle('RPLim', 'elf_a');
select pg_temp.mk_members('RPLim', 'Ora', 'Pia', 'Quin');
select pg_temp.mk_member('Rex', 'RPLim', null, true, null);
select pg_temp.to_sent('RPLim', 'Ora', 'Pia', 'Pia', 'Quin', 'Quin', 'Rex', 'Rex', 'Ora');
select pg_temp.mk_circle('RNone', 'elf_a');
select pg_temp.mk_member('Sid', 'RNone', null, true, null);
select pg_temp.mk_member('Tao', 'RNone', null, true, null);
select pg_temp.mk_member('Una', 'RNone', null, true, null);
select pg_temp.to_sent('RNone', 'Sid', 'Tao', 'Tao', 'Una', 'Una', 'Sid');

-- Another Elf's member; a lock circle; a stale-pending circle; a member-view circle.
select pg_temp.mk_circle('RZ', 'elf_b');
select pg_temp.mk_members('RZ', 'Zed');
select pg_temp.mk_circle('RLock', 'elf_a');
select pg_temp.mk_members('RLock', 'Ann', 'Bob', 'Cat');
select pg_temp.to_sent('RLock', 'Ann', 'Bob', 'Bob', 'Cat', 'Cat', 'Ann');
select pg_temp.mk_circle('RStale', 'elf_a');
select pg_temp.mk_members('RStale', 'Dot', 'Ed', 'Flo');
select pg_temp.to_sent('RStale', 'Dot', 'Ed', 'Ed', 'Flo', 'Flo', 'Dot');
select pg_temp.mk_circle('RView', 'elf_a');
select pg_temp.mk_members('RView', 'Gil', 'Hub', 'Ivy');
select pg_temp.to_sent('RView', 'Gil', 'Hub', 'Hub', 'Ivy', 'Ivy', 'Gil');

-- Audit findings (RS-24..29).
select pg_temp.mk_circle('RBusy', 'elf_a');
select pg_temp.mk_members('RBusy', 'Jan', 'Kim', 'Lia');
select pg_temp.to_sent('RBusy', 'Jan', 'Kim', 'Kim', 'Lia', 'Lia', 'Jan');
select pg_temp.mk_circle('RBusy2', 'elf_a');
select pg_temp.mk_members('RBusy2', 'Moe', 'Nia', 'Omar');
select pg_temp.to_sent('RBusy2', 'Moe', 'Nia', 'Nia', 'Omar', 'Omar', 'Moe');
select pg_temp.mk_circle('RSweep', 'elf_a');
select pg_temp.mk_members('RSweep', 'Pat', 'Rue', 'Sue');
select pg_temp.to_sent('RSweep', 'Pat', 'Rue', 'Rue', 'Sue', 'Sue', 'Pat');
select pg_temp.mk_circle('RSend', 'elf_a');
select pg_temp.mk_members('RSend', 'Tom', 'Val', 'Wyn');
select pg_temp.to_sent('RSend', 'Tom', 'Val', 'Val', 'Wyn', 'Wyn', 'Tom');
select pg_temp.mk_circle('RList', 'elf_a');
select pg_temp.mk_members('RList', 'Xia', 'Yul', 'Zia');
select pg_temp.to_sent('RList', 'Xia', 'Yul', 'Yul', 'Zia', 'Zia', 'Xia');

-- RS-01 the function ----------------------------------------------------------
select ok(to_regprocedure('public.claim_reshuffle(uuid,uuid[],boolean)') is not null,
          'RS-01 public.claim_reshuffle(uuid, uuid[], boolean) exists');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.claim_reshuffle(uuid,uuid[],boolean)')),
          array['p_circle_id', 'p_member_ids', 'p_dry_run'], 'RS-01 argument names are the spec''s');
select is((select prosecdef from pg_proc where oid = to_regprocedure('public.claim_reshuffle(uuid,uuid[],boolean)')),
          true, 'RS-01 it is SECURITY DEFINER');
select ok(coalesce((select exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
                      from pg_proc where oid = to_regprocedure('public.claim_reshuffle(uuid,uuid[],boolean)')), false),
          'RS-01 it pins search_path');

-- RS-02 service_role only -----------------------------------------------------
select is(pg_temp.can_exec('service_role', 'public.claim_reshuffle(uuid,uuid[],boolean)'), true,
          'RS-02 service_role can execute claim_reshuffle');
select is(array[pg_temp.can_exec('public',        'public.claim_reshuffle(uuid,uuid[],boolean)'),
                pg_temp.can_exec('anon',          'public.claim_reshuffle(uuid,uuid[],boolean)'),
                pg_temp.can_exec('authenticated', 'public.claim_reshuffle(uuid,uuid[],boolean)')],
          array[false, false, false], 'RS-02 public, anon and authenticated cannot execute it');
select pg_temp.keep('rs02_before', pg_temp.snap('R3'));
select pg_temp.act_as('elf_a');
select pg_temp.keep('rs02_elf', pg_temp.try(format('select public.claim_reshuffle(%L::uuid, %L::uuid[], true)', pg_temp.id('R3'), pg_temp.all_ids('R3'))));
select pg_temp.act_as_anon();
select pg_temp.keep('rs02_anon', pg_temp.try(format('select public.claim_reshuffle(%L::uuid, %L::uuid[], true)', pg_temp.id('R3'), '{}')));
select pg_temp.as_postgres();
select ok(to_regprocedure('public.claim_reshuffle(uuid,uuid[],boolean)') is not null and pg_temp.val('rs02_elf') like '42501%',
          'RS-02 the owning Elf calling it directly is refused (' || pg_temp.val('rs02_elf') || ')');
select ok(to_regprocedure('public.claim_reshuffle(uuid,uuid[],boolean)') is not null and pg_temp.val('rs02_anon') like '42501%',
          'RS-02 anon calling it directly is refused (' || pg_temp.val('rs02_anon') || ')');
select is(pg_temp.snap('R3'), pg_temp.val('rs02_before'), 'RS-02 ... and the refused calls changed nothing');

-- RS-03 only from sent --------------------------------------------------------
select pg_temp.keep('rs03_open', pg_temp.snap('ROpen'));
select pg_temp.rs_all('rs03a', 'ROpen', false);
select is(pg_temp.res('rs03a'), 'false|names have not been sent yet', 'RS-03 an open circle is refused');
select is(pg_temp.snap('ROpen'), pg_temp.val('rs03_open'), 'RS-03 ... and nothing changed');
select pg_temp.keep('rs03_drawn', pg_temp.snap('RDrawn'));
select pg_temp.rs_all('rs03b', 'RDrawn', false);
select is(pg_temp.res('rs03b'), 'false|names have not been sent yet', 'RS-03 a drawn circle is refused');
select is(pg_temp.snap('RDrawn'), pg_temp.val('rs03_drawn'), 'RS-03 ... and nothing changed');
select pg_temp.rs('rs03c', gen_random_uuid(), '{}', true);
select is(pg_temp.res('rs03c'), 'false|circle not found', 'RS-03 an unknown circle says circle not found');
select pg_temp.keep('rs03_r3', pg_temp.snap('R3'));
select pg_temp.rs('rs03d', pg_temp.id('R3'), pg_temp.all_ids('R3'), null);
select is(pg_temp.res('rs03d') || ' / ' || pg_temp.snap('R3'), 'false|bad request / ' || pg_temp.val('rs03_r3'),
          'RS-03 a null p_dry_run is a bad request and changes nothing');

-- RS-04 the plain RPCs stay refused -------------------------------------------
select pg_temp.keep('rs04_before', pg_temp.snap('RLock'));
select pg_temp.act_as('elf_a');
select throws_ok(format('select public.reshuffle(%L::uuid)', pg_temp.id('RLock')), null, 'names have already been sent',
                 'RS-04 plain reshuffle on a sent circle still says names have already been sent (STAT-08)');
select throws_ok(format('select public.undo_draw(%L::uuid)', pg_temp.id('RLock')), null, 'names have already been sent',
                 'RS-04 undo_draw on a sent circle still says names have already been sent');
select pg_temp.as_postgres();
select is(pg_temp.snap('RLock'), pg_temp.val('rs04_before'), 'RS-04 ... and nothing changed');

-- RS-05 three kids: exactly one rematch ---------------------------------------
select pg_temp.rs_loop('rs05', 'R3', 30);
select is(pg_temp.bad_draws('rs05'), '', 'RS-05 30 re-shuffles of 3 kids: all valid, none repeats a current match');
-- Deterministic: from a 3-cycle the only rematch is the reverse cycle.
select is((select count(distinct sig) from pg_temp.t_draws where tag = 'rs05'), 2::bigint,
          'RS-05 the draw only ever alternates between the two possible states');
select is(pg_temp.circle_status('R3'), 'sent', 'RS-05 the circle is still sent');

-- RS-06 one-way ban, reverse allowed ------------------------------------------
select pg_temp.rs_loop('rs06', 'R4', 40, array['Dan', 'Eli', 'Eli', 'Fay', 'Fay', 'Gia', 'Gia', 'Dan']);
select is(pg_temp.bad_draws('rs06'), '', 'RS-06 40 re-shuffles from a 4-cycle: all valid, none repeats a current match');
-- Exactly two rematches exist. A fair draw misses one of them with p = 2 * 2^-40.
select is((select count(*) from pg_temp.t_draws where tag = 'rs06' and sig = 'Dan>Gia,Eli>Dan,Fay>Eli,Gia>Fay') > 0, true,
          'RS-06 the exact reverse of the current cycle is drawn: a reverse is allowed (one-way ban)');
select is((select count(*) from pg_temp.t_draws where tag = 'rs06' and sig = 'Dan>Fay,Eli>Gia,Fay>Dan,Gia>Eli') > 0, true,
          'RS-06 the other possible rematch is drawn too');

-- RS-07 eight kids with do-not-pairs ------------------------------------------
select pg_temp.rs_loop('rs07', 'R8', 30);
select is(pg_temp.bad_draws('rs07'), '',
          'RS-07 30 chained re-shuffles of 8 kids: no self-draw, no do-not-pair break, no repeat, gives and receives once');
select is((select count(*) from pg_temp.t_draws where tag = 'rs07'), 30::bigint, 'RS-07 all 30 runs were recorded');

-- RS-08 stays sent, opened_at reset -------------------------------------------
update public.matches set opened_at = now() where circle_id = pg_temp.id('RDry');
select pg_temp.keep('rs08_tokens', (select string_agg(token, ',' order by id) from public.members where circle_id = pg_temp.id('RDry')));
select pg_temp.rs_all('rs08', 'RDry', true);
select is(pg_temp.res('rs08'), 'true|', 'RS-08 a sent circle with opened links can be re-shuffled');
select is(pg_temp.circle_status('RDry'), 'sent', 'RS-08 the circle stays sent');
select is((select count(*) from public.matches where circle_id = pg_temp.id('RDry') and opened_at is not null), 0::bigint,
          'RS-08 every opened_at is reset');
select is((select string_agg(token, ',' order by id) from public.members where circle_id = pg_temp.id('RDry')),
          pg_temp.val('rs08_tokens'), 'RS-08 tokens do not change: the kids keep the same link');

-- RS-10 dry run (RDry, just re-shuffled at used 0) ----------------------------
select is(pg_temp.rows_for('RDry', 'pending'), 'Vic,Wes,Xan', 'RS-10 a dry run writes a pending reshuffle row per kid');
select is((select count(*) from public.texts t join public.members m on m.id = t.member_id
            where m.circle_id = pg_temp.id('RDry') and t.dry_run and t.kind = 'reshuffle'), 3::bigint,
          'RS-10 those rows are dry-run rows');
delete from public.texts t using public.members m where m.id = t.member_id and m.circle_id = pg_temp.id('RDry');
select pg_temp.set_budget(45, 45, null);
select pg_temp.rs_all('rs10', 'RDry', true);
select is(pg_temp.res('rs10') || ' used ' || pg_temp.budget_used(), 'true| used 45',
          'RS-10 a dry run at the cap is accepted and spends no credits');

-- RS-09 a real claim ----------------------------------------------------------
select pg_temp.set_budget(45, 10, 20);
select pg_temp.rs_all('rs09', 'RReal', false);
select is(pg_temp.res('rs09'), 'true|', 'RS-09 a real re-shuffle is accepted');
select is(pg_temp.rows_for('RReal', 'pending'), 'Sam,Tia,Uma', 'RS-09 one pending reshuffle row per kid');
select is((select count(*) from public.texts t join public.members m on m.id = t.member_id
            where m.circle_id = pg_temp.id('RReal') and not t.dry_run), 3::bigint, 'RS-09 they are real rows (dry_run false)');
select is(pg_temp.budget_used()::text || ' ' || pg_temp.last_quota(), '13 17',
          'RS-09 3 credits are claimed: used 10 -> 13 and last_quota 20 -> 17');
select is((select coalesce(array_agg(x order by x), '{}') from (select (e->>'text_id')::uuid x from jsonb_array_elements(pg_temp.view('rs09')->'texts') e) s),
          (select coalesce(array_agg(t.id order by t.id), '{00000000-0000-0000-0000-000000000000}') from public.texts t join public.members m on m.id = t.member_id
            where m.circle_id = pg_temp.id('RReal') and t.status = 'pending'),
          'RS-09 the result lists the pending rows'' ids');
select is(jsonb_array_length(coalesce(pg_temp.view('rs09')->'skipped', '[0]'::jsonb)), 0, 'RS-09 nobody is skipped');

-- RS-11 impossible ------------------------------------------------------------
select pg_temp.set_budget(45, 0, null);
update public.matches set opened_at = now() where giver_id = pg_temp.id('Ima');
select pg_temp.keep('rs11_before', pg_temp.snap('RX'));
select pg_temp.rs_all('rs11', 'RX', false);
select is(pg_temp.res('rs11'), 'false|Can''t make a draw with these do-not-pair rules. Try removing one.',
          'RS-11 no valid rematch: ok false with the do-not-pair message');
select is(pg_temp.snap('RX'), pg_temp.val('rs11_before'),
          'RS-11 matches, opened_at, status, rows and credits are all unchanged');
select pg_temp.rs_all('rs11d', 'RX', true);
select is(pg_temp.res('rs11d') || ' / ' || pg_temp.snap('RX'),
          'false|Can''t make a draw with these do-not-pair rules. Try removing one. / ' || pg_temp.val('rs11_before'),
          'RS-11 a dry run is refused the same way and writes nothing');

-- RS-12 cap -------------------------------------------------------------------
select pg_temp.set_budget(45, 43, null);
update public.matches set opened_at = now() where giver_id = pg_temp.id('Yan');
select pg_temp.keep('rs12_before', pg_temp.snap('RCap'));
select pg_temp.rs_all('rs12', 'RCap', false);
select is(pg_temp.res('rs12'), 'false|text budget used up', 'RS-12 43 + 3 > 45 refuses with text budget used up');
select is(pg_temp.snap('RCap'), pg_temp.val('rs12_before'), 'RS-12 ... with the matches, opened_at, rows and credits unchanged');
select pg_temp.set_budget(45, 42, null);
select pg_temp.rs_all('rs12b', 'RCap', false);
select is(pg_temp.res('rs12b') || ' used ' || pg_temp.budget_used(), 'true| used 45', 'RS-12 42 + 3 = 45 fits exactly');

-- RS-13 reserve ---------------------------------------------------------------
select pg_temp.set_budget(45, 0, 7);
select pg_temp.keep('rs13_before', pg_temp.snap('RRes'));
select pg_temp.rs_all('rs13', 'RRes', false);
select is(pg_temp.res('rs13'), 'false|text budget used up', 'RS-13 last_quota 7 - 3 would dig into the reserve of 5: refused');
select is(pg_temp.snap('RRes'), pg_temp.val('rs13_before'), 'RS-13 ... with nothing changed');
select pg_temp.set_budget(45, 0, 8);
select pg_temp.rs_all('rs13b', 'RRes', false);
select is(pg_temp.res('rs13b') || ' quota ' || pg_temp.last_quota(), 'true| quota 5', 'RS-13 landing exactly on the reserve is allowed');

-- RS-14 rate limit: all or nothing --------------------------------------------
select pg_temp.set_budget(45, 0, null);
select pg_temp.mk_old_text('Eve', 'invite', 'sent', true, 50);
select pg_temp.mk_old_text('Eve', 'invite', 'failed', false, 40);
select pg_temp.mk_old_text('Eve', 'reveal', 'pending', false, 20); -- stale: swept to failed, still counted
update public.matches set opened_at = now() where giver_id = pg_temp.id('Fin');
select pg_temp.keep('rs14_before', pg_temp.snap('RRate'));
select pg_temp.rs_all('rs14', 'RRate', false);
select is(pg_temp.res('rs14'), 'false|too many texts, try again in an hour',
          'RS-14 one kid at 3 texts this hour (dry-run, failed and swept-pending all count) refuses the whole batch');
select is(pg_temp.snap('RRate'), pg_temp.val('rs14_before'), 'RS-14 ... with nothing changed for anyone');
select pg_temp.rs_all('rs14d', 'RRate', true);
select is(pg_temp.res('rs14d') || ' / ' || pg_temp.snap('RRate'),
          'false|too many texts, try again in an hour / ' || pg_temp.val('rs14_before'),
          'RS-14 the limit applies in a dry run too');

-- RS-15 the limit is exact ----------------------------------------------------
select pg_temp.mk_old_text('Hal', 'invite', 'sent', false, 50);
select pg_temp.mk_old_text('Hal', 'reveal', 'sent', false, 40);
select pg_temp.mk_old_text('Ida', 'invite', 'sent', false, 61);
select pg_temp.mk_old_text('Ida', 'invite', 'sent', false, 62);
select pg_temp.mk_old_text('Ida', 'reveal', 'sent', false, 63);
select pg_temp.rs_all('rs15', 'ROld', false);
select is(pg_temp.res('rs15'), 'true|', 'RS-15 2 recent texts, or 3 older than an hour, are not at the limit');

-- RS-16 a phoneless kid -------------------------------------------------------
select pg_temp.set_budget(45, 0, null);
select pg_temp.keep('rs16_noa', (select receiver_id::text from public.matches where giver_id = pg_temp.id('Noa')));
select pg_temp.rs_all('rs16', 'RP', false);
select is(pg_temp.res('rs16'), 'true|', 'RS-16 a phoneless kid does not stop the re-shuffle');
select is(pg_temp.draw_verdict('RP'), 'ok', 'RS-16 the new draw covers every kid, phoneless included');
select isnt((select receiver_id::text from public.matches where giver_id = pg_temp.id('Noa')), pg_temp.val('rs16_noa'),
            'RS-16 the phoneless kid is re-matched');
select is(pg_temp.skipped('rs16', 'no phone number'), 'Noa', 'RS-16 they are skipped and reported as no phone number');
select is(pg_temp.rows_for('RP', 'pending') || ' used ' || pg_temp.budget_used(), 'Kai,Lou,Max used 3',
          'RS-16 only the kids with phones get rows and credits');

-- RS-17 a phoneless kid at the limit doesn't count ----------------------------
select pg_temp.mk_old_text('Rex', 'invite', 'sent', true, 30);
select pg_temp.mk_old_text('Rex', 'invite', 'sent', true, 31);
select pg_temp.mk_old_text('Rex', 'reveal', 'sent', true, 32);
select pg_temp.rs_all('rs17', 'RPLim', true);
select is(pg_temp.res('rs17'), 'true|', 'RS-17 a phoneless kid at 3 texts this hour is not being texted, so does not block');

-- RS-18 nobody has a phone: refused, because a sent draw must never change silently
select pg_temp.set_budget(45, 0, null);
select pg_temp.keep('rs18_before', pg_temp.snap('RNone'));
select pg_temp.rs_all('rs18', 'RNone', false);
select is(pg_temp.res('rs18'), 'false|nobody can be texted', 'RS-18 no phones at all: refused with nobody can be texted');
select is(pg_temp.snap('RNone'), pg_temp.val('rs18_before'), 'RS-18 ... with the matches, rows and credits unchanged');
select pg_temp.rs_all('rs18d', 'RNone', true);
select is(pg_temp.res('rs18d') || ' / ' || pg_temp.snap('RNone'),
          'false|nobody can be texted / ' || pg_temp.val('rs18_before'), 'RS-18 a dry run is refused the same way');

-- RS-19 another circle's member makes the list wrong ----------------------------
select pg_temp.set_budget(45, 3, null);
select pg_temp.keep('rs19_before', pg_temp.snap('RStale'));
select pg_temp.rs('rs19', pg_temp.id('RStale'), pg_temp.all_ids('RStale') || pg_temp.id('Zed'), false);
select is(pg_temp.res('rs19'), 'false|bad request', 'RS-19 a list holding another circle''s member is a bad request');
select is((select count(*) from public.texts where member_id = pg_temp.id('Zed'))::text || ' / ' || pg_temp.snap('RStale'),
          '0 / ' || pg_temp.val('rs19_before'), 'RS-19 that member gets no row and the circle is unchanged');

-- RS-21 a stale pending row is swept ------------------------------------------
select pg_temp.mk_old_text('Ann', 'reveal', 'pending', false, 15);
select pg_temp.rs_all('rs21', 'RLock', true);
select is((select status from public.texts t where t.member_id = pg_temp.id('Ann') and t.kind = 'reveal'), 'failed',
          'RS-21 a pending row older than 10 minutes in this circle is swept to failed');
select is(pg_temp.res('rs21'), 'true|', 'RS-21 ... and does not block the re-shuffle');

-- RS-20 the circle lock (RLock has just been claimed by this transaction) -----
select ok(pg_temp.row_locked_for_write('public.circles', pg_temp.id('RLock')),
          'RS-20 claim_reshuffle holds a writer lock on the circle row (got: '
          || pg_temp.row_lock_modes('public.circles', pg_temp.id('RLock')) || ')');

-- RS-04 again, after a re-shuffle ---------------------------------------------
select pg_temp.keep('rs04_after', pg_temp.draw_sig('RLock'));
select pg_temp.act_as('elf_a');
select throws_ok(format('select public.reshuffle(%L::uuid)', pg_temp.id('RLock')), null, 'names have already been sent',
                 'RS-04 plain reshuffle is still refused after a re-shuffle');
select pg_temp.as_postgres();
select is(pg_temp.draw_sig('RLock'), pg_temp.val('rs04_after'), 'RS-04 ... and the draw did not change');

-- RS-22 the same link shows the new match ------------------------------------
select pg_temp.capture_view('rs22_old', 'Gil');
select is(pg_temp.view('rs22_old')->'match'->>'id', pg_temp.id('Hub')::text, 'RS-22 (setup) before: Gil''s link shows Hub');
select pg_temp.rs_all('rs22', 'RView', true);
select is((select opened_at from public.matches where giver_id = pg_temp.id('Gil')), null,
          'RS-22 the re-shuffle cleared the opened_at Gil''s earlier view had set');
select pg_temp.capture_view('rs22_new', 'Gil');
select is(pg_temp.view('rs22_new')->'match'->>'id', pg_temp.id('Ivy')::text, 'RS-22 after: the same link shows the new match');
select isnt((select opened_at from public.matches where giver_id = pg_temp.id('Gil')), null,
            'RS-22 viewing sets opened_at again');

-- RS-23 texts.kind ------------------------------------------------------------
select is(pg_temp.outcome($$insert into public.texts (member_id, kind, status, created_at)
                            values (pg_temp.id('Sam'), 'reshuffle', 'sent', now())$$),
          'accepted', 'RS-23 texts.kind accepts reshuffle');

-- RS-24 one at a time: a live pending row in the circle refuses ---------------
select pg_temp.set_budget(45, 0, null);
select pg_temp.mk_old_text('Jan', 'reshuffle', 'pending', false, 1);
select pg_temp.keep('rs24_before', pg_temp.snap('RBusy'));
select pg_temp.rs_all('rs24', 'RBusy', false);
select is(pg_temp.res('rs24'), 'false|a send is already in progress', 'RS-24 a pending reshuffle row refuses a re-shuffle');
select is(pg_temp.snap('RBusy'), pg_temp.val('rs24_before'), 'RS-24 ... with the matches, rows and credits unchanged');
select pg_temp.rs_all('rs24d', 'RBusy', true);
select is(pg_temp.res('rs24d') || ' / ' || pg_temp.snap('RBusy'),
          'false|a send is already in progress / ' || pg_temp.val('rs24_before'), 'RS-24 a dry run is refused the same way');
-- Any kind counts ("any text for the circle"), and 9 minutes is inside the sweep window.
select pg_temp.mk_old_text('Moe', 'reveal', 'pending', true, 9);
select pg_temp.keep('rs24_b2', pg_temp.snap('RBusy2'));
select pg_temp.rs_all('rs24b', 'RBusy2', false);
select is(pg_temp.res('rs24b') || ' / ' || pg_temp.snap('RBusy2'),
          'false|a send is already in progress / ' || pg_temp.val('rs24_b2'),
          'RS-24 a 9-minute-old pending dry-run reveal also refuses, and nothing changes');

-- RS-25 a stale row doesn't block; another circle's pending row doesn't either --
-- (RBusy and RBusy2 still hold live pending rows at this point.)
select pg_temp.mk_old_text('Pat', 'reshuffle', 'pending', false, 11);
select pg_temp.keep('rs25_sig', pg_temp.draw_sig('RSweep'));
select pg_temp.rs_all('rs25', 'RSweep', true);
select is(pg_temp.res('rs25'), 'true|', 'RS-25 a pending row older than the sweep window does not block, nor does another circle''s pending row');
select isnt(pg_temp.draw_sig('RSweep'), pg_temp.val('rs25_sig'), 'RS-25 ... and the kids are re-matched');
select is((select status from public.texts where member_id = pg_temp.id('Pat') and kind = 'reshuffle' and dry_run = false), 'failed',
          'RS-25 ... and the stale row was swept to failed');

-- RS-26 a Re-send is refused while a re-shuffle is pending ------------------------
select pg_temp.set_budget(45, 0, null);
select pg_temp.rs_all('rs26_claim', 'RSend', false);
select pg_temp.keep('rs26_before', pg_temp.snap('RSend'));
select pg_temp.keep('rs26_ct', pg_temp.svc(format(
  'select public.claim_texts(p_circle_id => %L::uuid, p_kind => ''reveal'', p_member_ids => %L::uuid[], p_dry_run => false, p_resend => true)::text',
  pg_temp.id('RSend'), pg_temp.ids('Tom'))));
select is(pg_temp.val('rs26_ct')::jsonb->>'ok' || '|' || coalesce(pg_temp.val('rs26_ct')::jsonb->>'error', ''),
          'false|a send is already in progress', 'RS-26 Re-send while a reshuffle row is pending is refused');
select is(pg_temp.snap('RSend'), pg_temp.val('rs26_before'), 'RS-26 ... with no new row and no credit');

-- RS-27 a stale reshuffle row does not block a Re-send ----------------------------
update public.texts t set created_at = now() - interval '11 minutes'
  from public.members m where m.id = t.member_id and m.circle_id = pg_temp.id('RSend');
select pg_temp.keep('rs27_ct', pg_temp.svc(format(
  'select public.claim_texts(p_circle_id => %L::uuid, p_kind => ''reveal'', p_member_ids => %L::uuid[], p_dry_run => true, p_resend => true)::text',
  pg_temp.id('RSend'), pg_temp.ids('Tom'))));
select is(pg_temp.val('rs27_ct')::jsonb->>'ok', 'true', 'RS-27 once the reshuffle row is stale, a Re-send is allowed');

-- RS-28 each claimed text carries its receiver ------------------------------------
select is((select count(*) from jsonb_array_elements(pg_temp.view('rs09')->'texts') e
            where pg_temp.keys(e) = array['member_id', 'receiver_id', 'text_id']), 3::bigint,
          'RS-28 every entry in texts is exactly {member_id, receiver_id, text_id}');
select is((select count(*) from jsonb_array_elements(pg_temp.view('rs09')->'texts') e
             join public.matches x on x.giver_id = (e->>'member_id')::uuid and x.receiver_id = (e->>'receiver_id')::uuid), 3::bigint,
          'RS-28 receiver_id is each kid''s new match');

-- RS-29 p_member_ids must be the circle's full list -------------------------------
select pg_temp.set_budget(45, 0, null);
select pg_temp.keep('rs29_before', pg_temp.snap('RList'));
select pg_temp.rs('rs29a', pg_temp.id('RList'), pg_temp.ids('Xia', 'Yul'), false);
select is(pg_temp.res('rs29a') || ' / ' || pg_temp.snap('RList'), 'false|bad request / ' || pg_temp.val('rs29_before'),
          'RS-29 a list missing one kid is a bad request and changes nothing');
select pg_temp.rs('rs29b', pg_temp.id('RList'), '{}', false);
select is(pg_temp.res('rs29b') || ' / ' || pg_temp.snap('RList'), 'false|bad request / ' || pg_temp.val('rs29_before'),
          'RS-29 an empty list is a bad request and changes nothing');
select pg_temp.rs('rs29c', pg_temp.id('RList'), null, false);
select is(pg_temp.res('rs29c') || ' / ' || pg_temp.snap('RList'), 'false|bad request / ' || pg_temp.val('rs29_before'),
          'RS-29 a null list is a bad request and changes nothing');

select * from finish();
rollback;
