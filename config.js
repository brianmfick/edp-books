// The two public settings that connect this site to its Supabase database.
// The key here is Supabase's "publishable" key. It is meant to be public: on its
// own it can read nothing, because every table only answers to Brian's login.
// Never put the secret key in this file.
window.EDP_CONFIG = {
  url: "",
  key: ""
};
