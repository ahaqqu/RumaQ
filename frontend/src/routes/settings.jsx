import { createFileRoute } from '@tanstack/react-router'
import { useApp } from '../context/AppContext.jsx'
import { Settings } from '../pages/Settings.jsx'
import { RouteError } from '../components/RouteError.jsx'

function RouteComponent() {
  const { motion, setMotion } = useApp()

  // #523 P3: Settings no longer takes the browser-held AI key. The page reads
  // the household's providers/capabilities from the API; the last browser-side
  // provider call (persona rewrite) returns through the door in P5.
  return <Settings motion={motion} setMotion={setMotion} />
}

export const Route = createFileRoute('/settings')({
  component: RouteComponent,
  errorComponent: RouteError,
})
