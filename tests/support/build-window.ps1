param([string]$Source, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -Path $Source -OutputAssembly $Destination -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing
