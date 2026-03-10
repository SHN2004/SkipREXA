// Configuration will be loaded from Chrome storage
export let SUPABASE_URL = null;
export let SUPABASE_ANON_KEY = null;
export let supabase = null;

// Initialize credentials from Chrome storage
export async function initializeCredentials() {
  return new Promise((resolve, reject) => {
    // Check if we're running inside a Chrome Extension environment
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(['supabaseUrl', 'supabaseKey'], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        // Set up default credentials if not found
        if (!result.supabaseUrl || !result.supabaseKey) {
          console.log("🔧 Setting up default credentials...");
          const defaultUrl = 'https://avmoixumqzdydqrzquon.supabase.co';
          const defaultKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2bW9peHVtcXpkeWRxcnpxdW9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ1ODE2MjYsImV4cCI6MjA3MDE1NzYyNn0.nwJgP7j9s78OGdJpj8Gmle_hHX8Hdk7Ro0hNOEmFFVk';

          chrome.storage.sync.set({
            'supabaseUrl': defaultUrl,
            'supabaseKey': defaultKey
          }, () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            SUPABASE_URL = defaultUrl;
            SUPABASE_ANON_KEY = defaultKey;
            console.log("✅ Default credentials stored and loaded");
            initSupabase();
            resolve();
          });
        } else {
          SUPABASE_URL = result.supabaseUrl;
          SUPABASE_ANON_KEY = result.supabaseKey;
          console.log("✅ Credentials loaded from storage");
          initSupabase();
          resolve();
        }
      });
    } else {
      // Dev mode fallback in standard browser window
      console.log("🔧 Running outside extension environment. Using dev credentials...");
      SUPABASE_URL = 'https://avmoixumqzdydqrzquon.supabase.co';
      SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2bW9peHVtcXpkeWRxcnpxdW9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ1ODE2MjYsImV4cCI6MjA3MDE1NzYyNn0.nwJgP7j9s78OGdJpj8Gmle_hHX8Hdk7Ro0hNOEmFFVk';
      initSupabase();
      resolve();
    }
  });
}

export function initSupabase() {
  supabase = createSupabaseClient();
}

// Initialize Supabase client
export function createSupabaseClient() {
  return {
    from: (table) => ({
      select: (columns = "*") => {
        const query = {
          table,
          columns,
          filters: [],
        }

        return {
          eq: (column, value) => {
            // Encode the value to handle special characters (like #, &, etc.)
            query.filters.push(`${column}=eq.${encodeURIComponent(value)}`)
            return {
              eq: (column2, value2) => {
                query.filters.push(`${column2}=eq.${encodeURIComponent(value2)}`)
                return {
                  async data(options = {}) {
                    return executeQuery(query, options);
                  },
                }
              },
              async data(options = {}) {
                return executeQuery(query, options);
              },
            }
          },
          in: (column, values) => {
            if (Array.isArray(values) && values.length > 0) {
              // Format values: quote strings, join with comma
              // We escape double quotes with backslash (common for JSON/PostgREST)
              const formatted = values.map(v => `"${v.toString().replace(/"/g, '\\"')}"`).join(',');
              // Encode the entire RHS (in.(...)) to ensure safety
              const filterValue = `in.(${formatted})`;
              query.filters.push(`${column}=${encodeURIComponent(filterValue)}`);
            }
            return {
              async data(options = {}) {
                return executeQuery(query, options);
              }
            }
          },
          async data(options = {}) {
            return executeQuery(query, options);
          },
        }
      },
    }),
    // RPC method for calling Postgres functions
    rpc: (functionName, params = {}) => ({
      async data() {
        const url = `${SUPABASE_URL}/rest/v1/rpc/${functionName}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(params)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`RPC Error (${response.status}): ${errorText}`);
        }

        return await response.json();
      }
    })
  }
}

async function executeQuery(query, options = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${query.table}?select=${query.columns}`;
  if (query.filters && query.filters.length > 0) {
    url += "&" + query.filters.join("&");
  }

  // Add pagination parameters if provided
  if (options.limit) {
    url += `&limit=${options.limit}`;
  }
  if (options.offset) {
    url += `&offset=${options.offset}`;
  }

  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };

  // Add Range header for pagination
  if (options.offset !== undefined && options.limit !== undefined) {
    const rangeStart = options.offset;
    const rangeEnd = options.offset + options.limit - 1;
    headers['Range'] = `${rangeStart}-${rangeEnd}`;
  }

  const response = await fetch(url, { headers });
  const data = await response.json();
  return data;
}

// Fetch all records with pagination support
export async function fetchAllRecords(table, columns = "*", batchSize = 1000, statusCallback = null) {
  console.log(`📥 Fetching all records from ${table}...`);

  let allRecords = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      console.log(`📦 Fetching batch ${Math.floor(offset / batchSize) + 1} (offset: ${offset})`);

      if (statusCallback) {
        statusCallback(allRecords.length);
      }

      const batchData = await supabase
        .from(table)
        .select(columns)
        .data({ limit: batchSize, offset });

      console.log(`📊 Received ${batchData.length} records in this batch`);

      if (batchData.length === 0) {
        hasMore = false;
        console.log("📝 No more records to fetch");
      } else {
        allRecords = allRecords.concat(batchData);
        offset += batchSize;

        // If we got less than batchSize records, we've reached the end
        if (batchData.length < batchSize) {
          hasMore = false;
          console.log("📝 Reached end of records (partial batch)");
        }
      }

    } catch (error) {
      console.error(`❌ Error fetching batch at offset ${offset}:`, error);
      throw new Error(`Failed to fetch records: ${error.message}`);
    }
  }

  console.log(`✅ Successfully fetched all ${allRecords.length} records from ${table}`);
  return allRecords;
}

export const getSupabase = () => supabase;
export const getSupabaseUrl = () => SUPABASE_URL;
export const getSupabaseKey = () => SUPABASE_ANON_KEY;
