pragma solidity 0.6.12;
abstract contract SixBase {
    function value() public virtual returns (uint);
}
interface SixInterface { function read() external view returns (uint); }
contract Six is SixBase {
    receive() external payable {}
    function value() public override returns (uint) { return 6; }
}
