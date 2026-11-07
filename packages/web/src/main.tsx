import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ServicesContext } from './hooks/app';
import { createServices } from './lib/app';
import { forgetStoredToken, signIn, takeTokenFromUrl } from './lib/auth';
import { registerServiceWorker } from './lib/pwa';
import { setLinkResult } from './screens/TokenScreen';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/agent.css';
import './styles/desktop.css';

// A sign-in link (`/#token=...`): the token leaves the address bar before anything else, then is exchanged
// once for this device's session cookie; the WebSocket starts after that.
const linkToken = takeTokenFromUrl();
forgetStoredToken();
const services = createServices();
if (linkToken) {
  void signIn(linkToken).then((r) => {
    if (r !== 'ok') setLinkResult(r);
    services.conn.start();
  });
} else services.conn.start();
registerServiceWorker();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <App />
      </ServicesContext.Provider>
    </StrictMode>,
  );
}
