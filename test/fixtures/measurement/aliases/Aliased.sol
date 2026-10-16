pragma solidity 0.8.37;
import {Base as Parent, Twice as Scale, IValue as RemoteValue} from "./Base.sol";
contract Aliased is Parent {
    RemoteValue private source;
    function get() external view returns (uint256) { return source.value(); }
    function base() public pure override returns (uint256) { return Scale.twice(super.base()); }
}
