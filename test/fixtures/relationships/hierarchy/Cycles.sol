pragma solidity 0.8.37;

contract CycleA is CycleB {}

contract CycleB is CycleA {}

contract SelfLoop is SelfLoop {}

contract Heir is CycleA {}

contract Independent {}

contract IndependentChild is Independent {}
