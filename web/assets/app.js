import {welcome} from './welcome.js';
import './app-v12.js';

// The login interface is rendered synchronously by the application module.
// Its health check and saved-session refresh continue independently underneath.
welcome?.ready();
