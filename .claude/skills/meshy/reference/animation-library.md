# Meshy Animation Library — Action IDs

Sourced from docs.meshy.ai/en/api/animation-library (fetched 2026-04-17).

Use these integer `action_id` values with the Animation endpoint (`POST /openapi/v1/animations`).

**Source docs truncated at action_id 586.** The library continues beyond that — fetch the live page for the complete list when a user asks for something not in this file.

## Finding the right action_id

**By keyword:** grep this file for what you want. E.g. `"dance"`, `"kick"`, `"idle"`, `"wave"`.

**By category:** animations are grouped:
- **DailyActions** — Idle, LookingAround, Interacting, Transitioning, Sleeping, PickingUpItem, WorkingOut, Pushing, Drinking
- **WalkAndRun** — Walking, Running, CrouchWalking, Swimming, TurningAround
- **BodyMovements** — Acting, Climbing, PerformingStunt, Jumping, HangingfromLedge, FallingFreely, VaultingOverObstacle
- **Fighting** — Punching, AttackingwithWeapon, Blocking, Transitioning, CastingSpell, GettingHit, Dying
- **Dancing** — Dancing

## Idle & daily actions (0–60)

| ID | Name | Subcategory |
|---|---|---|
| 0 | Idle | Idle |
| 1 | Walking_Woman | Walking (WalkAndRun) |
| 2 | Alert | LookingAround |
| 3 | Arise | LookingAround |
| 4 | Attack | AttackingwithWeapon (Fighting) |
| 5 | BackLeft_run | Running (WalkAndRun) |
| 6 | BackRight_Run | Running (WalkAndRun) |
| 7 | BeHit_FlyUp | GettingHit (Fighting) |
| 8 | Dead | Dying (Fighting) |
| 9 | ForwardLeft_Run_Fight | Transitioning (Fighting) |
| 10 | ForwardRight_Run_Fight | Transitioning (Fighting) |
| 11 | Idle_02 | Idle |
| 12 | Idle_03 | Idle |
| 13 | Jump_Run | Running (WalkAndRun) |
| 14 | Run_02 | Running (WalkAndRun) |
| 15 | Run_03 | Running (WalkAndRun) |
| 16 | RunFast | Running (WalkAndRun) |
| 17 | Skill_01 | Acting (BodyMovements) |
| 18 | Skill_02 | Acting (BodyMovements) |
| 19 | Skill_03 | Acting (BodyMovements) |
| 20 | Walk_Fight_Back | Walking (WalkAndRun) |
| 21 | Walk_Fight_Forward | Walking (WalkAndRun) |
| 22 | FunnyDancing_01 | Dancing |
| 23 | FunnyDancing_02 | Dancing |
| 24 | FunnyDancing_03 | Dancing |
| 25 | Agree_Gesture | Interacting |
| 26 | Angry_Stomp | Interacting |
| 27 | Big_Heart_Gesture | Acting (BodyMovements) |
| 28 | Big_Wave_Hello | Interacting |
| 29 | Call_Gesture | Acting (BodyMovements) |
| 30 | Casual_Walk | Walking (WalkAndRun) |
| 31 | Catching_Breath | Acting (BodyMovements) |
| 32 | Chair_Sit_Idle_F | Idle |
| 33 | Chair_Sit_Idle_M | Idle |
| 34 | Checkout_Gesture | Interacting |
| 35 | Clapping_Run | Acting (BodyMovements) |
| 36 | Confused_Scratch | Idle |
| 37 | Discuss_While_Moving | Interacting |
| 38 | Dozing_Elderly | Idle |
| 39 | Excited_Walk_F | Acting (BodyMovements) |
| 40 | Excited_Walk_M | Acting (BodyMovements) |
| 41 | Formal_Bow | Interacting |
| 42 | Gentlemans_Bow | Interacting |
| 43 | Handbag_Walk | Acting (BodyMovements) |
| 44 | Happy_jump_f | Acting (BodyMovements) |
| 45 | Indoor_Play | Acting (BodyMovements) |
| 46 | Jump_Rope | Acting (BodyMovements) |
| 47 | Listening_Gesture | Interacting |
| 48 | Mirror_Viewing | Idle |
| 49 | Motivational_Cheer | Interacting |
| 50 | Phone_Call_Gesture | Interacting |
| 51 | Shouting_Angrily | Acting (BodyMovements) |
| 52 | Sit_to_Stand_Transition_F | Transitioning |
| 53 | Sit_to_Stand_Transition_M | Transitioning |
| 54 | Squat_Stance | Dancing |
| 55 | Stage_Walk | Walking (WalkAndRun) |
| 56 | Stand_and_Chat | Interacting |
| 57 | Stand_to_Sit_Transition_M | Transitioning |
| 58 | Step_to_Sit_Transition | Transitioning |
| 59 | Victory_Cheer | Acting (BodyMovements) |
| 60 | Walk_to_Sit | Transitioning |
| 61 | happy_jump_m | Acting (BodyMovements) |
| 62 | penguin_walk | Acting (BodyMovements) |

## Dancing (22-24, 63-84)

| ID | Name |
|---|---|
| 22 | FunnyDancing_01 |
| 23 | FunnyDancing_02 |
| 24 | FunnyDancing_03 |
| 54 | Squat_Stance |
| 63 | Arm_Circle_Shuffle |
| 64 | All_Night_Dance |
| 65 | Bass_Beats |
| 66 | Boom_Dance |
| 67 | Bubble_Dance |
| 68 | Cherish_Pop_Dance |
| 69 | Crystal_Beads |
| 70 | Cardio_Dance |
| 71 | Denim_Pop_Dance |
| 72 | Dont_You_Dare |
| 73 | Fast_Lightning |
| 74 | Gangnam_Groove |
| 75 | Indoor_Swing |
| 76 | Love_You_Pop_Dance |
| 77 | Magic_Genie |
| 78 | Not_Your_Mom |
| 79 | OMG_Groove |
| 80 | Pop_Dance_LSA2 |
| 81 | Pod_Baby_Groove |
| 82 | Shake_It_Off_Dance |
| 83 | Superlove_Pop_Dance |
| 84 | You_Groove |

## Fighting — combat stances, attacks, weapons (85-105, 125-242)

| ID | Name | Subcategory |
|---|---|---|
| 85 | Axe_Stance | Transitioning |
| 86 | Basic_Jump | AttackingwithWeapon |
| 87 | Boxing_Practice | Punching |
| 88 | Chest_Pound_Taunt | Transitioning |
| 89 | Combat_Stance | AttackingwithWeapon |
| 90 | Counterstrike | Punching |
| 91 | Double_Blade_Spin | AttackingwithWeapon |
| 92 | Double_Combo_Attack | AttackingwithWeapon |
| 93 | Dodge_and_Counter | Punching |
| 94 | Flying_Fist_Kick | Punching |
| 95 | Gun_Hold_Left_Turn | AttackingwithWeapon |
| 96 | Kung_Fu_Punch | Punching |
| 97 | Left_Slash | AttackingwithWeapon |
| 98 | Run_and_Shoot | AttackingwithWeapon |
| 99 | Reaping_Swing | Transitioning |
| 100 | Rightward_Spin | Transitioning |
| 101 | Sword_Shout | Acting (BodyMovements) |
| 102 | Sword_Judgment | AttackingwithWeapon |
| 103 | Simple_Kick | AttackingwithWeapon |
| 104 | Side_Shot | AttackingwithWeapon |
| 105 | Triple_Combo_Attack | AttackingwithWeapon |

### Casting spells
| ID | Name |
|---|---|
| 125 | Charged_Spell_Cast |
| 126 | Charged_Spell_Cast_1 |
| 127 | Charged_Ground_Slam |
| 128 | Heavy_Hammer_Swing |
| 129 | mage_soell_cast |
| 130 | mage_soell_cast_1 |
| 131 | mage_soell_cast_2 |
| 132 | mage_soell_cast_3 |
| 133 | mage_soell_cast_4 |
| 134 | mage_soell_cast_5 |
| 135 | mage_soell_cast_6 |
| 136 | mage_soell_cast_7 |
| 137 | mage_soell_cast_8 |

### Blocking
| ID | Name |
|---|---|
| 138-146 | Block1 through Block10 (Block7 skipped) |
| 147 | Sword_Parry |
| 148-155 | Sword_Parry_Backward + variants |
| 149 | Two_Handed_Parry |
| 150 | Hit_Reaction_with_Bow |

### Dodging
| ID | Name |
|---|---|
| 156, 157, 162, 164 | Stand_Dodge + variants |
| 158-161, 163 | Roll_Dodge + variants |

### Reloading
| ID | Name |
|---|---|
| 165 | Kneeling_Reload |
| 166 | Running_Reload |
| 167 | Slow_Walk_Reload |
| 168 | Prone_Reload |
| 169 | Forward_Reload_Subtle |
| 170 | Standing_Reload |

### Getting hit
| ID | Name |
|---|---|
| 171 | Hit_Reaction_to_Waist |
| 172 | Electrocution_Reaction |
| 173 | Slap_Reaction |
| 174-176 | Face_Punch_Reaction + variants |
| 177 | Gunshot_Reaction |
| 178-179 | Hit_Reaction + variants |
| 180 | Shot_in_the_Back_and_Fall |

### Dying
| ID | Name |
|---|---|
| 181 | Electrocuted_Fall |
| 182 | Shot_and_Blown_Back |
| 183 | Shot_and_Fall_Backward |
| 184 | Shot_and_Fall_Forward |
| 185 | Shot_and_Slow_Fall_Backward |
| 186 | Strangled_and_Fall_Forward |
| 187 | Knock_Down |
| 188 | Fall_Dead_from_Abdominal_Injury |
| 189 | dying_backwards |
| 190 | Knock_Down_1 |

### Punching combos
| ID | Name |
|---|---|
| 191 | Left_Jab_from_Guard |
| 192 | Right_Jab_from_Guard |
| 193 | Left_Hook_from_Guard |
| 194 | Right_Uppercut_from_Guard |
| 195 | Right_Upper_Hook_from_Guard |
| 196 | Left_Uppercut_from_Guard |
| 197 | Left_Short_Hook_from_Guard |
| 198 | Punch_Combo |
| 199 | Weapon_Combo |
| 200-205 | Punch_Combo_1 through Punch_Combo_5 (plus Weapon_Combo_1) |

### Kicks
| ID | Name |
|---|---|
| 206 | Spartan_Kick |
| 207 | Roundhouse_Kick |
| 208 | Lunge_Roundhouse_Kick |
| 209 | Boxing_Guard_Right_Straight_Kick |
| 210 | Boxing_Guard_Prep_Straight_Punch |
| 211 | Boxing_Guard_Step_Knee_Strike |
| 212 | Elbow_Strike |
| 213 | Leg_Sweep |
| 214 | Punch_Forward_with_Both_Fists |
| 215 | High_Kick |
| 216 | Lunge_Spin_Kick |
| 217 | Sweeping_Kick |
| 218 | Step_in_High_Kick |

### Sword / shield
| ID | Name |
|---|---|
| 219 | Right_Hand_Sword_Slash |
| 220 | Shield_Push_Left |
| 221 | Charged_Upward_Slash |

### Archery / ranged
| ID | Name |
|---|---|
| 222-229 | Draw_and_Shoot_from_Back + variants, Archery_Shot variants |
| 230 | Walk_Backward_with_Bow_Aimed |
| 231 | Archery_Aim_with_Lateral_Scan |
| 232 | Cowboy_Quick_Draw_Shooting |
| 233-234 | Walk_Backward/Forward_While_Shooting |
| 235 | Forward_Roll_and_Fire |
| 236 | Draw_and_Shoot_Left |

### Axe / big weapons
| ID | Name |
|---|---|
| 237 | Charged_Axe_Chop |
| 238 | Axe_Spin_Attack |
| 239 | Crouch_Pull_and_Throw |
| 240 | Thrust_Slash |
| 241 | Weapon_Combo_2 |
| 242 | Charged_Slash |

## Extended idle + stationary (243-258)

| ID | Name |
|---|---|
| 243-254 | Idle_3 through Idle_14 |
| 255-257 | Angry_Ground_Stomp + variants |
| 258 | CrouchLookAroundBow |

## Pushing (259-262)

| ID | Name |
|---|---|
| 259 | Step_Forward_and_Push |
| 260 | Push_Forward_and_Stop |
| 261 | Push_and_Walk_Forward |
| 262 | Crouch_and_Push_Forward |

## Sleeping (263-272)

| ID | Name |
|---|---|
| 263 | Sleep_on_Desk |
| 264 | Cough_While_Sleeping |
| 265 | Groan_Holding_Stomach_in_Sleep |
| 266 | Lie_Down_Hands_Spread |
| 267 | Sleep_Normally |
| 268 | Sit_and_Doze_Off |
| 269 | sleep |
| 270 | Toss_and_Turn |
| 271 | Wake_Up_and_Look_Up |
| 272 | Lie_on_Chair_Sunbathe_and_Sleep |

## Picking up items (273-284)

| ID | Name |
|---|---|
| 273 | Male_Run_Forward_Pick_Up_Left |
| 274 | Female_Crouch_Pick_Up_Place_Side |
| 275 | Female_Run_Forward_Pick_Up_Right |
| 276 | Male_Bend_Over_Pick_Up |
| 277 | Female_Crouch_Pick_Fruit_Basket_Stand |
| 278 | Female_Stand_Pick_Fruit_Basket |
| 279 | Female_Crouch_Pick_Gun_Point_Forward |
| 280 | Female_Crouch_Pick_Throw_Forward |
| 281 | Female_Bend_Over_Pick_Up_Inspect |
| 282 | Female_Walk_Pick_Put_In_Pocket |
| 283 | Pull_Radish |
| 284 | Collect_Object |

## Interactions (285-318)

| ID | Name |
|---|---|
| 285-289 | open_door + variants |
| 290-296 | Wave_One_Hand, Wave_for_Help variants |
| 297 | Personalized_Gesture |
| 298-306 | Cheer / clap / wave transitions (various) |
| 307 | Sitting_Answering_Questions |
| 308 | Talk_Passionately |
| 309-316 | Talking / gesturing variants |
| 317 | Shrug |
| 318 | Scheming_Hand_Rub |

## Working out / fitness (319-331)

| ID | Name |
|---|---|
| 319 | air_squat |
| 320 | bicep_curl |
| 321 | bicycle_crunch |
| 322 | circle_crunch |
| 323 | golf_drive |
| 324 | idle_to_push_up |
| 325 | jump_push_up |
| 326 | jumping_jacks |
| 327 | kettlebell_swing |
| 328 | push_up_to_idle |
| 329 | push_up |
| 330 | situps |
| 331 | Sumo_High_Pull |

## Looking around (333-341)

| ID | Name |
|---|---|
| 333 | Look_Around_Dumbfounded |
| 334 | Lower_Weapon_Look_Raise |
| 335 | Axe_Breathe_and_Look_Around |
| 336 | Long_Breathe_and_Look_Around |
| 337 | Torch_Look_Around |
| 338 | Short_Breathe_and_Look_Around |
| 339 | Walking_Scan_with_Sudden_Look_Back |
| 340 | Crawl_and_Look_Back |
| 341 | Walk_Slowly_and_Look_Around |

## Drinking + sitting transitions (342-372)

| ID | Name |
|---|---|
| 342 | Stand_and_Drink |
| 343 | Sit_and_Drink |
| 344-353 | Stand_Up1 through Stand_Up10 |
| 354-372 | Sitting / kneeling / lying down transitions |

## Acting / stunts / acrobatics (375-422)

| ID | Name |
|---|---|
| 375 | Handstand_Flip |
| 376 | Punch_Pose |
| 377 | Relax_arms_then_strike_battle_pose |
| 378 | Large_step_then_high_kick |
| 379 | Side_jumps_in_horse_stance |
| 381 | Step_Right_for_Exercise |
| 382 | Jump_and_Slam_Back_Down |
| 384 | Quick_Step_and_Spin_Dodge |
| 385 | Boxing_Warmup |
| 386 | Zombie_Scream |
| 387 | Half_Squat_with_Thumb_Up |
| 388 | Show_Both_Arm_Muscles |
| 389 | Grip_and_Throw_Down |
| 390 | Stand_on_Pole_and_Balance |
| 391 | Head_Hold_in_Pain |
| 392 | Ground_Flip_and_Sweep_Up |
| 393 | baseball_pitching |
| 394 | Backflip_and_Hooks |
| 395 | Breakdance_1990 |
| 396 | Burpee_Exercise |
| 397 | 360_Power_Spin_Jump |
| 398 | Crouch_Charge_and_Throw |
| 399 | Step_Step_Turn_Kick |
| 401 | Sprint_Roll_and_Flip |
| 402 | Run_and_Leap |
| 403 | Victory_Fist_Pump |
| 404 | Crouch_and_Step_Back |
| 405 | Joyful_Dance_with_Hand_Sway |
| 406 | Thomas_Flair_to_Jump_Up |
| 407 | Wall_Push_Jump_and_Flip |
| 408 | Jazz_Hands |
| 409 | Finger_Wag_No |
| 410 | Kick_a_Soccer_Ball |
| 411 | Neck_Slashing_Gesture |
| 412 | victory |
| 413 | Backflip_and_Rise |
| 414 | Double_kick_forward |
| 415 | Happy_Sway_Standing |
| 416 | Hit_in_Back_While_Running |
| 417 | Hop_with_Arms_Raised |
| 419 | Jump_to_Catch_and_Fall |
| 420 | Left_Hand_Bitten_Step_Back |
| 421 | Over_Shoulder_Throw |
| 422 | Rising_Flying_Kick |

## Vaulting over obstacles (425-433)

| ID | Name |
|---|---|
| 425 | Vault_with_Rifle |
| 426 | Roll_Behind_Cover |
| 427 | Vault_and_Land |
| 428 | Unarmed_Vault |
| 429 | Parkour_Vault |
| 430 | Parkour_Vault_with_Roll |
| 431-433 | Parkour_Vault_1/2/3 |

## Climbing (434-449, 497)

| ID | Name |
|---|---|
| 434 | Fast_Ladder_Climb |
| 435 | Ladder_Climb_Finish |
| 436 | Ladder_Mount_Start |
| 437 | Slow_Ladder_Climb |
| 438 | Ladder_Climb_Loop |
| 439 | Climb_Left_with_Both_Limbs |
| 440 | Climb_Right_with_Both_Limbs |
| 441 | Climb_Stairs |
| 442 | Fast_Stair_Climb |
| 444 | climbing_up_wall |
| 445 | diagonal_wall_run |
| 446 | Hang_and_Climb_Left |
| 447 | Hang_and_Climb_Rght |
| 448 | Jump_and_Grab_Wall |
| 449 | Climb_Up_Rope |
| 497 | climbing_down_wall |

## Stunts + jumps (450-472)

| ID | Name |
|---|---|
| 450 | Wall_Flip |
| 451 | One_Arm_Handstand |
| 452 | Backflip |
| 453 | Backflip_Sweep_Kick |
| 455 | Sweep_Kick |
| 456 | Jumping_Head_Scissor_Takedown |
| 457 | Jumping_Punch |
| 458 | Unicycle_Jump_Dismount |
| 459 | Run_Jump_and_Roll |
| 460-472 | Various jumps (Jump_with_Arms_Open, Backflip_Jump, Regular_Jump, Jump_Over_Obstacle, etc.) |

## Hanging from ledge / rope (473-496)

| ID | Name |
|---|---|
| 473 | Quad_Jump_Left |
| 474 | Quad_Jump_Up |
| 475 | Quad_Climb_Right |
| 476 | Hang_and_Push_with_Foot |
| 477 | Rope_Hang_Idle |
| 478 | Bar_Hang_Idle |
| 479-481 | Upside_Down_Rope_Hang variants |
| 482 | Grab_Wall_Midair_Idle |
| 483-484 | Slow_Bar_Hang_Left/Right |
| 485 | Jump_and_Hang_on_Bar |
| 486 | Wall_Support_to_Step_Down |
| 490-496 | Fall_Down, Fall_from_Bar, Wall_Support_Jump_to_Ground, etc. |

## Falling freely (487-508)

| ID | Name |
|---|---|
| 487-489 | Climb_Attempt_and_Fall_3/4/5 |
| 498-500 | Climb_Attempt_and_Fall / _1 / _2 |
| 501 | Leap_of_Faith |
| 502-505 | Fall1 through Fall4 |
| 506-508 | Dive_Down_and_Land variants |

## Running — specialized (509-519, 530-539)

| ID | Name |
|---|---|
| 509 | Lean_Forward_Sprint |
| 510 | Standard_Forward_Charge |
| 511 | Rifle_Charge |
| 512 | Male_Head_Down_Charge |
| 513 | Female_Head_Down_Charge |
| 514 | Female_Bow_Charge_Left_Hand |
| 515 | Female_Throwing_Stance_Charge |
| 516 | slide_light |
| 517 | slide_right |
| 518 | sliding_rool |
| 519 | sliding_stumble |
| 530-539 | run_fast_2 through run_fast_10 (and Sprint_and_Sudden_Stop at 531) |

## Crouch walking (520-529)

| ID | Name |
|---|---|
| 520 | Crouch_Walk_with_Torch |
| 521 | Crouch_Walk_Left_with_Torch |
| 522 | Crouch_Walk_Right_with_Torch |
| 523 | Cautious_Crouch_Walk_Backward |
| 524 | Cautious_Crouch_Walk_Forward |
| 525 | Cautious_Crouch_Walk_Left |
| 526 | Cautious_Crouch_Walk_Right |
| 527 | Crouch_Walk_Left_with_Gun |
| 528 | Walk_Left_with_Gun |
| 529 | Walk_Backward_with_Gun |

## Walking — many variants (30, 55, 106-124, 540-567)

The most-populated category. Highlights:

| ID | Name |
|---|---|
| 30 | Casual_Walk |
| 55 | Stage_Walk |
| 106 | Confident_Walk |
| 107 | Confident_Strut |
| 108 | Flirty_Strut |
| 111 | Injured_Walk |
| 112 | Monster_Walk |
| 113 | Mummy_Stagger |
| 114 | Proud_Strut |
| 115 | Quick_Walk |
| 117 | Red_Carpet_Walk |
| 118 | Skip_Forward |
| 119 | Slow_Orc_Walk |
| 121 | Thoughtful_Walk |
| 122 | Texting_Walk |
| 123 | Unsteady_Walk |
| 124 | Walking_with_Phone |
| 540-544 | Walk_Backward variants |
| 545-548 | Walk_Backward with weapon variants |
| 549 | Crawl_Backward |
| 550-552 | Carrying objects while walking |
| 553 | Elderly_Shaky_Walk |
| 554 | Funky_Walk |
| 555-558 | Limping_Walk variants |
| 559 | Sneaky_Walk |
| 560 | Spear_Walk |
| 561 | Step_Hip_Hop_Dance |
| 562 | Stumble_Walk |
| 563 | Stylish_Walk |
| 564 | Tightrope_Walk |
| 565 | Walk_with_Umbrella |
| 566 | walking_2 |
| 567 | Walk_with_Walker_Support |

## Swimming (568-570)

| ID | Name |
|---|---|
| 568 | Swim_Idle |
| 569 | Swim_Forward |
| 570 | swimming_to_edge |

## Turning (571-586)

| ID | Name |
|---|---|
| 571 | Run_Turn_Left |
| 572 | Walk_Turn_Left |
| 573 | Rifle_Turn_Left |
| 574 | Walk_Turn_Left_with_Weapon |
| 575 | Combat_Idle_Turn_Left |
| 576 | Idle_Turn_Left |
| 577 | Idle_Step_Turn_Left |
| 578 | Idle_Torch_Turn_Left |
| 579 | Depressed_Full_Turn_Left |
| 580 | Sword_and_Shield_Alert_Turn_Left |
| 581 | Run_Sharp_Turn_Right |
| 582 | Run_Turn_Right |
| 583 | Walk_Turn_Right |
| 584 | Walk_Turn_Right_Female |
| 585 | Rifle_Aim_Turn_Right |
| 586 | Idle_Turn_Right |

## ID > 586 not captured in this file

The Meshy library continues beyond 586. Fetch https://docs.meshy.ai/en/api/animation-library directly when a user wants an animation not found here.
