I'd like to overhaul the skill and persona systems. The new architecture looks like this:

| plugin name              | function                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skills                   | broker that provides recall tools for agent, skill.md file parsing and API surface for skill provider plugins to register themselves and their skills                   |
| persona                  | broker that provides persona management tools for agent, persona.md file parsing and API surface for persona provider plugins to register themselves and their personas |
| skill-provider-project  | plugin that allows skills to be defined at the project level                                                                                                            |
| persona-provider-project | plugin that allows personas to be defined at the project level                                                                                                          |
| skill-provider-user      | plugin that allows skills to be defined at the user level                                                                                                               |
| persona-provider-user    | plugin that allows personas to be defined at the user level                                                                                                             |

Further changes:

- `skills` and `persona` plugins should provide an API for provider plugins to negotiate their precedence order. We'll do this by number, smallest wins, and define the following constants: PRECEDENCE_SWARM = 5000, PRECEDENCE_COORDINATOR = 4000, PRECEDENCE_USER = 3000, PRECEDENCE_PROJECT = 2000. The provider plugins will be able to register their precedence number with the broker, and the broker will use that to determine which provider to use when looking up skills or personas.
- Personas should be able to bring their own skills. Skills owned by a user-level persona should have a predecende of 2500, and skills owned by a project-level persona should have a precedence of 1500. This will allow personas to override skills defined at the user or project level.
