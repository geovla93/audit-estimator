pragma solidity 0.8.37;
contract Parent { function inherited() internal virtual returns (uint) { return 1; } }
contract SameName {}
contract DiamondBase {}
contract DiamondLeft is DiamondBase {}
contract DiamondRight is DiamondBase {}
contract Diamond is DiamondLeft, DiamondRight {}
