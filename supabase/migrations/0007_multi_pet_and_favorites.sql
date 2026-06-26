-- 0007_multi_pet_and_favorites.sql
-- Multiple pets per user + per-pet saved favorites, plus a dormant is_pro flag
-- so unlimited pets / per-pet favorites can be gated to a Pro tier later.

create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text, nickname text, species text default 'dog',
  breed text, age text, weight text,
  is_primary boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists pets_user_idx on public.pets(user_id);
alter table public.pets enable row level security;
drop policy if exists "pets_own" on public.pets;
create policy "pets_own" on public.pets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.pet_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  upc text not null, product jsonb,
  created_at timestamptz default now(),
  unique (pet_id, upc)
);
create index if not exists pet_favorites_pet_idx on public.pet_favorites(pet_id);
alter table public.pet_favorites enable row level security;
drop policy if exists "pet_favorites_own" on public.pet_favorites;
create policy "pet_favorites_own" on public.pet_favorites for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.profiles add column if not exists is_pro boolean default false;

drop trigger if exists pets_touch_updated_at on public.pets;
create trigger pets_touch_updated_at before update on public.pets
  for each row execute function public.touch_updated_at();

-- migrate any existing single pet stored on profiles into the new pets table
insert into public.pets (user_id, name, nickname, species, breed, age, weight, is_primary)
select id, pet_name, pet_nickname,
       case when pet_type in ('dog','cat') then pet_type else 'dog' end,
       pet_breed, pet_age, pet_weight, true
from public.profiles p
where (pet_name is not null or pet_nickname is not null or pet_breed is not null)
  and not exists (select 1 from public.pets pp where pp.user_id = p.id);
