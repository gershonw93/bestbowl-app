-- 0006_pet_profile_fields.sql
-- Richer single-pet profile fields collected on the "My pet" settings page,
-- so the app can be personal (name, nickname, breed, age, weight).
alter table public.profiles
  add column if not exists pet_name     text,
  add column if not exists pet_nickname text,
  add column if not exists pet_breed    text,
  add column if not exists pet_age      text,
  add column if not exists pet_weight   text;
