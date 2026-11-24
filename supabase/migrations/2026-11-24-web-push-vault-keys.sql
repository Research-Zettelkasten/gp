-- Store the fallback VAPID keypair in Supabase Vault. Only the Edge sender can access it.
begin;

create or replace function public.gp_push_vault_keys(p_public_key text, p_private_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  keys jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('glasspro:web-push:vapid',0));
  select decrypted_secret::jsonb into keys from vault.decrypted_secrets where name = 'glasspro_web_push_vapid';
  if found then return keys; end if;
  if exists (select 1 from public.gp_push_devices) then
    raise exception 'Restore the original Web Push signing keys for the enrolled devices.';
  end if;
  if coalesce(p_public_key,'') !~ '^[A-Za-z0-9_-]{87}$'
     or coalesce(p_private_key,'') !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Invalid Web Push key format.';
  end if;
  keys := jsonb_build_object('publicKey',p_public_key,'privateKey',p_private_key);
  perform vault.create_secret(keys::text,'glasspro_web_push_vapid','GLASSPRO Web Push signing keys');
  return keys;
end $$;

revoke all on function public.gp_push_vault_keys(text,text) from public,anon,authenticated;
grant execute on function public.gp_push_vault_keys(text,text) to service_role;
notify pgrst,'reload schema';
commit;
