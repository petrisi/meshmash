import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

const { app: state } = await import('./lib/state.svelte')
if (__BRIDGE__) (await import('./lib/transport/bridge')).takePairing()
state.autoConnect()
if (import.meta.env.DEV) Object.assign(window, { meshmash: state })

export default app
