// lib/features/home/presentation/screens/home_screen.dart

import 'package:flutter/material.dart';
import 'package:cifra_band/features/setlist/presentation/screens/setlist_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  // Abre direto na aba central (Aba 2)
  int _currentIndex = 2; 

  final List<Widget> _screens = [
    const Center(child: Text('Cursos (Em breve)', style: TextStyle(color: Colors.white, fontSize: 20))),
    const Center(child: Text('Treino (Em breve)', style: TextStyle(color: Colors.white, fontSize: 20))),
    const Center(child: Text('Nova Busca Premium (Em construção)', style: TextStyle(color: Colors.orange, fontSize: 18))), // Aba 2 Limpa
    const SetlistScreen(), // Aba 3: Sua tela de Setlist original
    const Center(child: Text('Conta (Em breve)', style: TextStyle(color: Colors.white, fontSize: 20))),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF121212),
      body: IndexedStack(
        index: _currentIndex,
        children: _screens,
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.centerDocked,
      floatingActionButton: FloatingActionButton(
        backgroundColor: Colors.blueAccent,
        shape: const CircleBorder(),
        elevation: 6,
        onPressed: () {
          setState(() => _currentIndex = 2);
        },
        child: const Icon(Icons.search, color: Colors.white, size: 32),
      ),
      bottomNavigationBar: BottomAppBar(
        color: const Color(0xFF1E1E1E), 
        shape: const CircularNotchedRectangle(),
        notchMargin: 8.0,
        child: SizedBox(
          height: 65,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildTabItem(icon: Icons.home_filled, label: 'Cursos', index: 0),
                  _buildTabItem(icon: Icons.headphones, label: 'Treino', index: 1),
                ],
              ),
              const SizedBox(width: 48), 
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildTabItem(icon: Icons.library_music, label: 'Setlist', index: 3),
                  _buildTabItem(icon: Icons.person, label: 'Conta', index: 4),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTabItem({required IconData icon, required String label, required int index}) {
    final isSelected = _currentIndex == index;
    return MaterialButton(
      minWidth: 40,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      onPressed: () => setState(() => _currentIndex = index),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, color: isSelected ? Colors.blueAccent : Colors.grey.shade600, size: 26),
          const SizedBox(height: 4),
          Text(
            label, 
            style: TextStyle(
              color: isSelected ? Colors.blueAccent : Colors.grey.shade600, 
              fontSize: 10,
              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal
            )
          ),
        ],
      ),
    );
  }
}