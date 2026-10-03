# Package configuration of the Device Modeler build integration: find_package(Hsm CONFIG REQUIRED PATHS "<hsm>/cmake")
# provides hsm_generate() and hsm_add_tests(), see HsmGenerate.cmake.
include("${CMAKE_CURRENT_LIST_DIR}/HsmGenerate.cmake")
set(Hsm_FOUND TRUE)
