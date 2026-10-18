-- ===========================================================================
-- 00 -- Schema shape
-- ===========================================================================
-- Spec: "Data model", "Privacy rules" 3 (collect as little as possible),
-- "Access rules" (RLS on every table). Scenarios SCH-01..05 in tests/SCENARIOS.md.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(14);

-- SCH-01
select ok(pg_version_num() > 0, 'SCH-01 pgTAP is installed and runnable');

-- SCH-02
select has_table('public', 'circles',    'SCH-02 table circles exists');
select has_table('public', 'members',    'SCH-02 table members exists');
select has_table('public', 'wish_items', 'SCH-02 table wish_items exists');
select has_table('public', 'no_pairs',   'SCH-02 table no_pairs exists');
select has_table('public', 'matches',    'SCH-02 table matches exists');
select has_table('public', 'texts',      'SCH-02 table texts exists');

-- SCH-03: every spec column present (the result is the list of missing ones).
select is(
  array(select c from unnest(array['id','elf_id','name','budget','swap_date','swap_place','status','created_at']) c
        except
        select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'circles'
        order by 1),
  '{}'::text[], 'SCH-03 circles has every spec column');

select is(
  array(select c from unnest(array['id','member_id','text','url','position']) c
        except
        select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'wish_items'
        order by 1),
  '{}'::text[], 'SCH-03 wish_items has every spec column');

select is(
  array(select c from unnest(array['circle_id','member_a','member_b']) c
        except
        select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'no_pairs'
        order by 1),
  '{}'::text[], 'SCH-03 no_pairs has every spec column');

select is(
  array(select c from unnest(array['circle_id','giver_id','receiver_id','opened_at']) c
        except
        select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'matches'
        order by 1),
  '{}'::text[], 'SCH-03 matches has every spec column');

select is(
  array(select c from unnest(array['id','member_id','kind','status','provider_id','error','created_at']) c
        except
        select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'texts'
        order by 1),
  '{}'::text[], 'SCH-03 texts has every spec column');

-- SCH-04: members holds exactly what the spec lists and nothing more about a kid.
select is(
  array(select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'members'
         order by 1),
  array['circle_id','created_at','fav_color','fav_snack','first_name','id','list_done',
        'phone','please_no','sizes','token'],
  'SCH-04 members has exactly the spec columns (no email, birthday, school, ...)');

-- SCH-05: RLS on for every table in public. Lists the offenders.
select is(
  array(select c.relname::text
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
         order by 1),
  '{}'::text[], 'SCH-05 row-level security is enabled on every table in public');

select * from finish();
rollback;
