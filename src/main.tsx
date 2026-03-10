import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './globals.css';
import { initializeCredentials } from './supabase-client';

initializeCredentials().then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}).catch(err => {
    console.error("Failed to initialize Supabase credentials:", err);
    ReactDOM.createRoot(document.getElementById('root')!).render(
        <div style={{ padding: '20px', color: 'red' }}>Failed to initialize connection: {err.message}</div>
    );
});
