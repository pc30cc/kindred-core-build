CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $handle_new_user$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, company_name, website_domain, main_goal, ai_mode, signup_locale, signup_ip)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.raw_user_meta_data->>'companyName',
    NEW.raw_user_meta_data->>'websiteDomain',
    NEW.raw_user_meta_data->>'mainGoal',
    NEW.raw_user_meta_data->>'aiMode',
    NEW.raw_user_meta_data->>'locale',
    NEW.raw_user_meta_data->>'signup_ip'
  );

  PERFORM public.provision_account_on_signup(NEW.id);

  RETURN NEW;
END;
$handle_new_user$;
