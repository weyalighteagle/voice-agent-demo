import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn("[supabase] Missing env vars:", {
    SUPABASE_URL: !!url,
    SUPABASE_SERVICE_KEY: !!key,
  });
  console.warn("[supabase] Knowledge base will be disabled");
}

const supabase = url && key ? createClient(url, key) : null;

export default supabase;
