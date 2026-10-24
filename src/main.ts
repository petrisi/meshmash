import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

if (import.meta.env.DEV) Object.assign(window, { meshmash: (await import('./lib/state.svelte')).app })

export default app
