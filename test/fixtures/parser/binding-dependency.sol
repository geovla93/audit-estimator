pragma solidity 0.8.37;
contract Parent { function inherited() internal virtual returns (uint) { return 2; } }
contract DirectChild is Parent {
    function inheritedCall() internal returns (uint) { return inherited(); }
    function superCall() internal returns (uint) { return super.inherited(); }
}
contract SameName {}
interface IRemote { function ping(uint value) external returns (uint); }
library Helpers { function twice(uint value) internal pure returns (uint) { return value * 2; } }
