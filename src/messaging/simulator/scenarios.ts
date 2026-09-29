// Ready-made worlds for the CLI and tests.

import type { ChatWorld, SimUser } from "./world";

/** Four iPhone friends planning a trip, with history from before Nod exists. */
export function seedTulumGroup(world: ChatWorld) {
  const users = {
    will: world.addUser({ name: "Will", platform: "iphone" }),
    jake: world.addUser({ name: "Jake", platform: "iphone" }),
    sarah: world.addUser({ name: "Sarah", platform: "iphone" }),
    mike: world.addUser({ name: "Mike", platform: "iphone" }),
  } satisfies Record<string, SimUser>;
  const { will, jake, sarah, mike } = users;
  const groupId = world.createGroup({ name: "Tulum 🌴", createdBy: will.id, members: [will.id, jake.id, sarah.id, mike.id] });

  const historyMessageIds = [
    world.say(will.id, groupId, "ok tulum march 14-18, who's in"),
    world.say(jake.id, groupId, "in"),
    world.say(sarah.id, groupId, "in!! https://airbnb.com/rooms/111 has a pool"),
    world.say(mike.id, groupId, "in if it's under 300 a night. https://airbnb.com/rooms/222"),
    world.say(jake.id, groupId, "I'll give the pool one the nod honestly"),
  ];
  historyMessageIds.push(world.react(will.id, historyMessageIds[2]!, "love"));

  return { users, groupId, historyMessageIds };
}

/** Two iPhones and two Androids: an SMS group that people can't add Nod to. */
export function seedMixedGroup(world: ChatWorld) {
  const users = {
    will: world.addUser({ name: "Will", platform: "iphone" }),
    sarah: world.addUser({ name: "Sarah", platform: "iphone" }),
    priya: world.addUser({ name: "Priya", platform: "android" }),
    dan: world.addUser({ name: "Dan", platform: "android" }),
  } satisfies Record<string, SimUser>;
  const { will, sarah, priya, dan } = users;
  const groupId = world.createGroup({ name: "Brunch", createdBy: priya.id, members: [will.id, sarah.id, priya.id, dan.id] });

  const historyMessageIds = [
    world.say(priya.id, groupId, "brunch sunday?"),
    world.say(dan.id, groupId, "yes. Lupa or Buvette"),
  ];
  historyMessageIds.push(world.react(will.id, historyMessageIds[1]!, "like"));

  return { users, groupId, historyMessageIds };
}
