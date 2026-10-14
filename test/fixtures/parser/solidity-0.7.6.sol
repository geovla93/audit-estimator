pragma solidity 0.7.6;
abstract contract SevenBase {
    function value() public virtual returns (uint);
}
contract Seven is SevenBase {
    function value() public override returns (uint) { return 7; }
    function checked(uint x) public pure returns (uint) { return x + 1; }
}
