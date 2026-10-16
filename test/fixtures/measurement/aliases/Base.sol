pragma solidity 0.8.37;
interface IValue {
    function value() external view returns (uint256);
}
library Twice {
    function twice(uint256 value) internal pure returns (uint256) { return value * 2; }
}
abstract contract Base {
    function base() public pure virtual returns (uint256) { return 3; }
}
