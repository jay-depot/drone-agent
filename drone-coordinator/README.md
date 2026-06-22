Placeholder for `drone-coordinator` subpackage.

Drone Coordinator will be the cross-host control plane for managing beacons across machines in the longer-term swarm vision. It will handle discovery of drone instances across hosts, coordination of tasks between them, and management of shared state for distributed agent execution.

Drone coordinator expects, and requires, a beacon running on the same host in order to operate. The coordinator will use that beacon to launch drone agents to maintain itself and to execute tasks on that host as needed.

Open question: Do we want to support using the coordinator to handle all scheduled tasks, even on remote hosts, or should we require that to be handled at the beacon or local-crontab level?
